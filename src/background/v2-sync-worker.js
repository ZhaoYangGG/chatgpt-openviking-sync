'use strict';
importScripts('../shared/core.js','../shared/source-time.js','../capture/parser.js','../capture/signed-bridge.js',
 '../shared/sync-status.js','status-badge.js','capture-auth.js','message-store.js','openviking-client.js','reconcile.js','sync-engine.js');
const store=new OpenVikingMessageStore.MessageStore();
const CONFIG='ov_v2_config',CHANNELS='ov_v2_channels',CAPTURE_ERRORS='v2SyncCaptureErrors';
const ready=Promise.all([
 chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}),
 chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})
]);
let captureChain=Promise.resolve(),diagnosticChain=Promise.resolve(),captureQueued=0,flushPromise=null;
const badges=chrome.action&&chrome.tabs?OpenVikingStatusBadge.create({chrome,statusModel:OpenVikingSyncStatus,readStatus:status}):null;
const updateSync=store.updateSync.bind(store);
store.updateSync=async(...args)=>{const result=await updateSync(...args);badges?.schedule();return result;};
chrome.tabs?.onActivated?.addListener(()=>badges?.schedule());
chrome.tabs?.onUpdated?.addListener((_id,change)=>{if(change.url||change.status==='complete')badges?.schedule();});
chrome.tabs?.onRemoved?.addListener(()=>badges?.schedule());
chrome.storage.onChanged?.addListener((changes,area)=>{
 if(area==='local'&&['ov_v2_config','v2SyncLastCapture',CAPTURE_ERRORS].some(k=>k in changes))badges?.schedule();
});
badges?.schedule();
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
function senderConversation(sender){
 try{return new URL(sender.url).pathname.match(/^\/(?:g\/[^/]+\/)?c\/([a-zA-Z0-9_-]{1,160})\/?$/)?.[1]||null;}catch{return null;}
}
// Diagnostics are bounded and isolated by destination and conversation. A success
// in B must not hide A's failure, nor may A's error paint every tab as failed.
function captureDiagnostic(context,error){
 if(!context.scope||!context.id)return Promise.resolve();
 const job=diagnosticChain.then(async()=>{
  const entries=(await chrome.storage.local.get(CAPTURE_ERRORS))[CAPTURE_ERRORS]||{};
  const key=JSON.stringify([context.scope,context.id]);
  if(error)entries[key]={error,stage:context.stage,step:context.step,at:Date.now()};
  else delete entries[key];
  const keys=Object.keys(entries).sort((a,b)=>entries[b].at-entries[a].at);
  for(const key of keys.slice(128))delete entries[key];
  await chrome.storage.local.set({[CAPTURE_ERRORS]:entries});
 });
 diagnosticChain=job.catch(()=>{});return job;
}
async function initialize(sender,diagnostic){
 await ready;
 diagnostic.step='channel_storage';
 const entries=await channels(),key=sender.documentId;
 let entry=entries[key];
 if(!entry||entry.tabId!==sender.tab.id){
  entry={tabId:sender.tab.id,channel:crypto.randomUUID(),secret:Array.from(crypto.getRandomValues(new Uint8Array(32))),lastSeq:0,at:Date.now()};
  entries[key]=entry;
  const ids=Object.keys(entries).sort((a,b)=>entries[b].at-entries[a].at);
  for(const id of ids.slice(128))delete entries[id];
  await chrome.storage.session.set({[CHANNELS]:entries});
 }
 diagnostic.step='install_bridge';
 const result=await chrome.scripting.executeScript({target:{tabId:sender.tab.id,documentIds:[sender.documentId]},
  world:'MAIN',injectImmediately:true,func:OpenVikingSignedBridge.install,args:[entry.secret,entry.channel]});
 if(!result.some(r=>r.result==='installed'||r.result==='already_installed'))throw Error('bridge_install_failed');
 return {ok:true};
}
async function capture(message,sender,diagnostic){
 await ready;
 diagnostic.step='authenticate';
 const entries=await channels(),entry=entries[sender.documentId];
 if(entry?.tabId!==sender.tab.id||!await OpenVikingCaptureAuth.verify(message,entry))return {ok:false,error:'capture_auth_failed'};
 entry.lastSeq=message.seq;await chrome.storage.session.set({[CHANNELS]:entries});
 const c=await getConfig(),scope=await scopeOf(c);
 diagnostic.scope=scope;diagnostic.step='parse_envelope';
 const payload=JSON.parse(message.text);
 if(!OpenVikingDetailParser.isId(payload.id))throw Error('invalid_capture');
 diagnostic.id=payload.id;
 if(payload.error){
  await captureDiagnostic(diagnostic,'capture_failed_or_limit');
  return {ok:false};
 }
 const kind=payload.kind||'detail';
 if(!['detail','page'].includes(kind))throw Error('invalid_capture_kind');
 // Keep privacy attestations in trusted session storage, never in page messages
 // or persistent IDB. They survive worker suspension but not a browser restart.
 // Map keys are prefixed to avoid prototype-property collisions on source IDs.
 const contexts=entry.contexts||{},contextKey='c:'+payload.id;
 const priorContext=contexts[contextKey];
 if(kind==='detail'){
  delete contexts[contextKey];entry.contexts=contexts;
  await chrome.storage.session.set({[CHANNELS]:entries});
 }
 const context=priorContext?.scope===scope?priorContext:null;
 diagnostic.step='parse_response';
 const detail=OpenVikingDetailParser.parseText(payload.body,payload.id,{kind,context});
 if(detail.excluded)delete contexts[contextKey];
 else if(kind==='detail'){
  // Bounded per-document cache. An evicted context fails closed until a fresh detail.
  delete contexts[contextKey];
  contexts[contextKey]={conversationId:payload.id,privacyAllowed:true,title:detail.title,scope};
  for(const key of Object.keys(contexts).slice(0,-32))delete contexts[key];
 }
 entry.contexts=contexts;await chrome.storage.session.set({[CHANNELS]:entries});
 diagnostic.step='store_messages';
 const result=await store.ingest(scope,detail);
 if(!detail.excluded){
  diagnostic.step='legacy_mapping';
  // Import only the old Session mapping from this installation and matching destination.
  const old=await chrome.storage.local.get(['ov_config','ov_sync_state']);
  const prior=old.ov_config;
  if(prior&&prior.serverUrl===c.serverUrl&&prior.apiKey===c.apiKey&&(prior.agentId||'')===c.agentId){
   const sid=old.ov_sync_state?.conversations?.[payload.id]?.sessionId;
   if(typeof sid==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(sid))await store.updateSync(scope,payload.id,{sessionId:sid});
  }
  diagnostic.step='save_status';
  await chrome.storage.local.set({v2SyncLastCapture:{id:payload.id,at:Date.now()}});
  await captureDiagnostic(diagnostic,null);
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
 const small=await chrome.storage.local.get(['v2SyncLastCapture',CAPTURE_ERRORS]);
 return {ok:true,configured:!!c.serverUrl,enabled:allowed(c),conversation:conversation||null,
  lastCapture:small.v2SyncLastCapture||null,captureError:small[CAPTURE_ERRORS]?.[JSON.stringify([scope,id])]||null,mode:'best_effort'};
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
 const diagnostic={id:senderConversation(sender),scope:null,stage:m?.type==='V2_INIT'?'initialize':'capture',step:'configuration'};
 const reportBacklog=()=>{
  void getConfig().then(scopeOf).then(scope=>captureDiagnostic({...diagnostic,scope},'capture_backlog_limit')).catch(()=>{});
 };
 if(m?.type==='V2_RELAY_ERROR'){
  reportBacklog();reply({ok:true});return false;
 }
 if(!['V2_INIT','V2_SIGNED_CAPTURE'].includes(m?.type))return false;
 if(captureQueued>=4){
  reportBacklog();
  reply({ok:false,error:'capture_backlog_limit'});return false;
 }
 captureQueued++;
 const job=captureChain.then(async()=>{
  diagnostic.scope=await scopeOf(await getConfig());
  return m.type==='V2_INIT'?initialize(sender,diagnostic):capture(m,sender,diagnostic);
 });
 captureChain=job.catch(()=>{});
 const response=job.then(reply,async error=>{
  // Only fixed classifications may enter diagnostics; never persist raw exception
  // messages (JSON errors can contain private response fragments).
  const known=['pagination_context_missing','conversation_id_mismatch','unsupported_schema','invalid_message',
   'invalid_or_duplicate_id','capture_limit','json_depth_limit','duplicate_json_key','invalid_json',
   'storage_capacity_reached','transaction_aborted','invalid_scope','invalid_messages','invalid_message_identity',
   'bridge_install_failed','invalid_capture','invalid_capture_kind'];
  const names=['QuotaExceededError','DataError','TransactionInactiveError','UnknownError','AbortError','TypeError','ReferenceError','SyntaxError'];
  const reason=known.includes(error?.message)?error.message:names.includes(error?.name)?error.name:'capture_or_storage_failed';
  await captureDiagnostic(diagnostic,reason).catch(()=>{});
  reply({ok:false,error:reason});
 }).finally(()=>captureQueued--);
 // Keep error persistence in the capture ordering: a later success must not be
 // overwritten by a delayed failure record from an earlier capture.
 captureChain=response.catch(()=>{});
 return true;
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='ov-v2-retry')void flush();});
chrome.runtime.onInstalled.addListener(()=>{void chrome.alarms.create('ov-v2-retry',{periodInMinutes:1});void flush();});
chrome.runtime.onStartup.addListener(()=>{void chrome.alarms.create('ov-v2-retry',{periodInMinutes:1});void flush();});
void chrome.alarms.create('ov-v2-retry',{periodInMinutes:1});
void flush();
