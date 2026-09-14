'use strict';
importScripts('../shared/core.js','../shared/source-time.js','../capture/parser.js','../capture/signed-bridge.js',
 'capture-auth.js','message-store.js','openviking-client.js','reconcile.js','sync-engine.js');
const store=new OpenVikingMessageStore.MessageStore();
const CONFIG='ov_v2_config',CHANNELS='ov_v2_channels';
const ready=Promise.all([
 chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}),
 chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})
]);
let captureChain=Promise.resolve(),captureQueued=0,flushPromise=null;
async function getConfig(){
 await ready;
 const v=(await chrome.storage.local.get(CONFIG))[CONFIG]||{};
 return {...OpenVikingSyncCore.normalizeConfig({...v,enabled:v.enabled===true}),namespace:v.namespace||'default',
  sourceTrustAccepted:v.sourceTrustAccepted===true,legacyStopped:v.legacyStopped===true,revision:v.revision||''};
}
async function scopeOf(c){
 return 'v2:'+await store.hash(JSON.stringify([c.serverUrl,c.apiKey,c.agentId,c.namespace]));
}
function allowed(c){return c.enabled&&c.serverUrl&&c.sourceTrustAccepted&&c.legacyStopped;}
function pageSender(sender){try{return sender.frameId===0&&Number.isInteger(sender.tab?.id)&&!!sender.documentId&&new URL(sender.url).origin==='https://chatgpt.com';}catch{return false;}}
const trusted=(sender,page)=>sender.url===chrome.runtime.getURL(page);
async function channels(){return (await chrome.storage.session.get(CHANNELS))[CHANNELS]||{};}
async function initialize(sender){
 await ready;
 const entries=await channels(),key=sender.documentId;
 let entry=entries[key];
 if(!entry||entry.tabId!==sender.tab.id){
  entry={tabId:sender.tab.id,channel:crypto.randomUUID(),secret:Array.from(crypto.getRandomValues(new Uint8Array(32))),lastSeq:0,at:Date.now()};
  entries[key]=entry;
  const ids=Object.keys(entries).sort((a,b)=>entries[b].at-entries[a].at);
  for(const id of ids.slice(128))delete entries[id];
  await chrome.storage.session.set({[CHANNELS]:entries});
 }
 const result=await chrome.scripting.executeScript({target:{tabId:sender.tab.id,documentIds:[sender.documentId]},
  world:'MAIN',injectImmediately:true,func:OpenVikingSignedBridge.install,args:[entry.secret,entry.channel]});
 if(!result.some(r=>r.result==='installed'||r.result==='already_installed'))throw Error('bridge_install_failed');
 return {ok:true};
}
async function capture(message,sender){
 await ready;
 const entries=await channels(),entry=entries[sender.documentId];
 if(entry?.tabId!==sender.tab.id||!await OpenVikingCaptureAuth.verify(message,entry))return {ok:false,error:'capture_auth_failed'};
 entry.lastSeq=message.seq;await chrome.storage.session.set({[CHANNELS]:entries});
 const c=await getConfig(),scope=await scopeOf(c);
 const payload=JSON.parse(message.text);
 if(!OpenVikingDetailParser.isId(payload.id))throw Error('invalid_capture');
 if(payload.error){
  await chrome.storage.local.set({v2SyncCaptureError:{error:'capture_failed_or_limit',at:Date.now()}});
  return {ok:false};
 }
 const detail=OpenVikingDetailParser.parseText(payload.body,payload.id);
 const result=await store.ingest(scope,detail);
 if(!detail.excluded){
  // Import only the old Session mapping from this installation and matching destination.
  const old=await chrome.storage.local.get(['ov_config','ov_sync_state']);
  const prior=old.ov_config;
  if(prior&&prior.serverUrl===c.serverUrl&&prior.apiKey===c.apiKey&&(prior.agentId||'')===c.agentId){
   const sid=old.ov_sync_state?.conversations?.[payload.id]?.sessionId;
   if(typeof sid==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(sid))await store.updateSync(scope,payload.id,{sessionId:sid});
  }
  await chrome.storage.local.set({v2SyncLastCapture:{id:payload.id,at:Date.now()},v2SyncCaptureError:null});
  void flush();
 }
 return {ok:true,...result};
}
async function flush(force=false,idFilter){
 if(flushPromise)return flushPromise;
 flushPromise=(async()=>{
  const config=await getConfig();if(!allowed(config))return;
  const scope=await scopeOf(config);
  const client=new OpenVikingClientModule.OpenVikingClient(config,{fetch:(url,opts)=>fetch(url,{...opts,redirect:'error',credentials:'omit'})});
  const engine=new OpenVikingSyncEngine.SyncEngine({store,client,reconcile:OpenVikingReconcile.reconcile,toIso:OpenVikingSourceTime.toIso,
   isEnabled:async()=>{const current=await getConfig();return allowed(current)&&current.revision===config.revision;}});
  const cs=await store.listConversations(scope);
  // Bounded work per wake; remaining queues resume at the next alarm/capture.
  let processed=0;
  for(const c of cs.sort((a,b)=>(a.lastSyncedAt||0)-(b.lastSyncedAt||0))){
   if(idFilter&&c.conversationId!==idFilter)continue;
   if(!c.queuedCount&&!c.pendingBatch&&(!c.migratedBySourceReadback||c.policyRevision===config.revision))continue;
   if(++processed>8)break;
   await engine.run(scope,c.conversationId,config,{force});
  }
 })().catch(()=>{}).finally(()=>{flushPromise=null;});
 return flushPromise;
}
async function status(id){
 const c=await getConfig(),scope=await scopeOf(c),conversation=id?await store.getConversation(scope,id):null;
 const small=await chrome.storage.local.get(['v2SyncLastCapture','v2SyncCaptureError']);
 return {ok:true,configured:!!c.serverUrl,enabled:allowed(c),conversation:conversation||null,
  lastCapture:small.v2SyncLastCapture||null,captureError:small.v2SyncCaptureError||null,mode:'best_effort'};
}
async function save(input){
 const rawUrl=new URL(input.serverUrl);
 if(rawUrl.username||rawUrl.password)throw Error('地址不能包含用户名或密码');
 if(rawUrl.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(rawUrl.hostname))throw Error('远端服务必须使用 HTTPS');
 if(!/^[a-zA-Z0-9_.-]{1,64}$/.test(input.namespace||''))throw Error('账户命名空间仅允许字母、数字、下划线、点和连字符');
 const config={...OpenVikingSyncCore.normalizeConfig(input),namespace:input.namespace,
  sourceTrustAccepted:input.sourceTrustAccepted===true,legacyStopped:input.legacyStopped===true,revision:crypto.randomUUID()};
 if(config.enabled&&(!config.sourceTrustAccepted||!config.legacyStopped))throw Error('开启前请确认页面信任边界与旧上传器已停止');
 if(!await chrome.permissions.contains({origins:[rawUrl.origin+'/*']}))throw Error('未授予服务地址权限');
 await chrome.storage.local.set({[CONFIG]:config});
 // Same-ID upgrades cannot restart the old DOM uploader; separate V1 extensions must be stopped by the user.
 const old=(await chrome.storage.local.get('ov_config')).ov_config;
 if(old)await chrome.storage.local.set({ov_config:{...old,enabled:false}});
 void flush();
 return {ok:true};
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
 const options=trusted(sender,'src/options/v2-options.html'),popup=trusted(sender,'src/popup/v2-sync-popup.html');
 if(options||popup){
  (async()=>{
   if(m?.type==='V2_STATUS')return status(m.conversationId);
   if(m?.type==='V2_RETRY'){void flush(true,m.conversationId);return {ok:true};}
   if(options&&m?.type==='V2_GET_CONFIG')return {ok:true,config:await getConfig()};
   if(options&&m?.type==='V2_SAVE_CONFIG')return save(m.config);
   if(options&&m?.type==='V2_TEST_CONNECTION'){
    const c=await getConfig();
    const client=new OpenVikingClientModule.OpenVikingClient(c,{fetch:(u,o)=>fetch(u,{...o,redirect:'error',credentials:'omit'})});
    const result=await client.testConnection();return {ok:true,version:result?.version||null};
   }
   return {ok:false,error:'unsupported_message'};
  })().then(reply,e=>reply({ok:false,error:m?.type==='V2_SAVE_CONFIG'?e.message:e.httpStatus?'HTTP_'+e.httpStatus:'operation_failed'}));
  return true;
 }
 if(!pageSender(sender))return false;
 if(m?.type==='V2_RELAY_ERROR'){
  void chrome.storage.local.set({v2SyncCaptureError:{error:'capture_backlog_limit',at:Date.now()}});reply({ok:true});return false;
 }
 if(!['V2_INIT','V2_SIGNED_CAPTURE'].includes(m?.type))return false;
 if(captureQueued>=4){
  void chrome.storage.local.set({v2SyncCaptureError:{error:'capture_backlog_limit',at:Date.now()}});
  reply({ok:false,error:'capture_backlog_limit'});return false;
 }
 captureQueued++;
 const job=captureChain.then(()=>m.type==='V2_INIT'?initialize(sender):capture(m,sender));
 captureChain=job.catch(()=>{});
 job.then(reply,()=>{
  void chrome.storage.local.set({v2SyncCaptureError:{error:'capture_or_storage_failed',at:Date.now()}});
  reply({ok:false,error:'capture_or_storage_failed'});
 }).finally(()=>captureQueued--);
 return true;
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='ov-v2-retry')void flush();});
chrome.runtime.onInstalled.addListener(()=>{void chrome.alarms.create('ov-v2-retry',{periodInMinutes:1});void flush();});
chrome.runtime.onStartup.addListener(()=>{void chrome.alarms.create('ov-v2-retry',{periodInMinutes:1});void flush();});
void chrome.alarms.create('ov-v2-retry',{periodInMinutes:1});
void flush();
