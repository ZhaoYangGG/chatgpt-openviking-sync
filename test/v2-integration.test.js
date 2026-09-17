'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const {MessageStore}=require('../src/background/message-store');
function harness({injectionError=null}={}){
 const idb=new IDBFactory(),local={},session={},injections=[],writes=[];let listener;
 const records=[];
 function storage(data){return {setAccessLevel:async()=>{},get:async k=>typeof k==='string'?{[k]:data[k]}:Object.fromEntries(k.map(x=>[x,data[x]])),set:async values=>Object.assign(data,values)};}
 const context=vm.createContext({URL,TextEncoder,crypto,Date,Promise,Set,Map,Array,JSON,Number,Error,Uint8Array,
  importScripts(){},
  OpenVikingSyncCore:require('../src/shared/core'),OpenVikingSourceTime:require('../src/shared/source-time'),
  OpenVikingDetailParser:require('../src/capture/parser'),OpenVikingSignedBridge:require('../src/capture/signed-bridge'),
  OpenVikingCaptureAuth:require('../src/background/capture-auth'),
  OpenVikingMessageStore:{MessageStore:class extends MessageStore{constructor(){super({indexedDB:idb,keyRange:IDBKeyRange});}}},
  OpenVikingClientModule:require('../src/background/openviking-client'),
  OpenVikingReconcile:require('../src/background/reconcile'),OpenVikingSyncEngine:require('../src/background/sync-engine'),
  fetch:async(url,opts)=>{
   const u=new URL(url),p=u.pathname;
   const payload=body=>new Response(JSON.stringify({status:'ok',result:body}),{headers:{'content-type':'application/json'}});
   if(opts.method==='POST'&&p.endsWith('/messages/batch')){
    const data=JSON.parse(opts.body);writes.push({path:p,data});records.push(...data.messages);return payload({total_message_count:records.length});
   }
   if(p==='/api/v1/fs/ls')return payload([{uri:'viking://session/legacy-session/messages.jsonl',isDir:false}]);
   if(p==='/api/v1/content/read')return payload(records.map(r=>JSON.stringify({...r,parts:[{type:'text',text:r.content}]})).join('\n'));
   if(p==='/api/v1/sessions/legacy-session')return payload({session_id:'legacy-session',uri:'viking://session/legacy-session',total_message_count:records.length,auto_commit_policy:null});
   throw Error('Unexpected request');
  },
  chrome:{
   storage:{local:storage(local),session:storage(session)},
   permissions:{contains:async()=>true},
   scripting:{executeScript:async args=>{injections.push(args);if(injectionError)throw injectionError;return [{result:'installed'}];}},
   runtime:{getURL:p=>'chrome-extension://unit/'+p,onMessage:{addListener:f=>{listener=f;}},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
   alarms:{create:async()=>{},onAlarm:{addListener(){}}}
  }});
 vm.runInContext(fs.readFileSync(require.resolve('../src/background/v2-sync-worker'),'utf8'),context);
 const sender={frameId:0,tab:{id:1},documentId:'synthetic-document',url:'https://chatgpt.com/c/c1'};
 const options={url:'chrome-extension://unit/src/options/v2-options.html'};
 async function send(m,s=sender){return new Promise(resolve=>{if(!listener(m,s,resolve))resolve({ignored:true});});}
 async function envelope(id='c1',seq=1,override=null,injection=0){
  const [secret,channel]=injections[injection].args;
  const body=JSON.stringify({conversation_id:id,is_temporary_chat:false,is_do_not_remember:false,title:'Synthetic',
   messages:[{id:'u',author:{role:'user'},status:'finished_successfully',create_time:1600000000.123456,
    content:{content_type:'text',parts:['Synthetic text']}}]});
  const text=JSON.stringify(override||{id,body});
  const key=await crypto.subtle.importKey('raw',new Uint8Array(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(channel+'\n'+seq+'\n'+text));
  return {type:'V2_SIGNED_CAPTURE',text,channel,seq,mac:Buffer.from(signature).toString('hex')};
 }
 return {send,envelope,local,session,injections,sender,options,writes,records};
}
const config={serverUrl:'https://example.com',apiKey:'secret-test-key',agentId:'',namespace:'default',
 enabled:false,sourceTrustAccepted:true,legacyStopped:true,autoCommitEnabled:false};
test('production manifest loads only signed relay and complete worker, with no legacy uploader',()=>{
 const manifest=require('../manifest.v2.json');
 assert.equal(manifest.background.service_worker,'src/background/v2-sync-worker.js');
 assert.deepEqual(manifest.content_scripts.flatMap(s=>s.js),['src/capture/signed-relay.js']);
 assert.ok(manifest.permissions.includes('scripting'));
 assert.equal(JSON.stringify(manifest).includes('v2-service-worker.js'),false);
 assert.equal(manifest.options_ui.page,'src/options/v2-options.html');
});
test('complete worker rejects raw spoof, wrong document, replay, page config access; accepts signed capture',async()=>{
 const h=harness();await h.send({type:'V2_SAVE_CONFIG',config},h.options);
 assert.equal((await h.send({type:'V2_GET_CONFIG'})).ignored,true);
 assert.equal((await h.send({type:'V2_CAPTURE',body:'{}'})).ignored,true);
 assert.equal((await h.send({type:'V2_INIT'})).ok,true);
 const message=await h.envelope();
 assert.equal((await h.send(message,{...h.sender,documentId:'wrong'})).ok,false);
 assert.equal((await h.send(message)).ok,true);
 assert.equal((await h.send(message)).ok,false);
 const result=await h.send({type:'V2_STATUS',conversationId:'c1'},h.options);
 assert.equal(result.conversation.messageCount,1);assert.equal(h.writes.length,0);
});
test('full worker uses matching V1 Session, writes real HTTP payload once and isolates destination changes',async()=>{
 const h=harness();h.local.ov_config={...config};h.local.ov_sync_state={conversations:{c1:{sessionId:'legacy-session'}}};
 await h.send({type:'V2_SAVE_CONFIG',config},h.options);await h.send({type:'V2_INIT'});await h.send(await h.envelope());
 const enabled=await h.send({type:'V2_SAVE_CONFIG',config:{...config,enabled:true}},h.options);assert.equal(enabled.ok,true);
 let status;
 for(let i=0;i<100;i++){await new Promise(r=>setImmediate(r));status=await h.send({type:'V2_STATUS',conversationId:'c1'},h.options);if(status.conversation?.syncStatus==='synced')break;}
 assert.equal(status.conversation.syncStatus,'synced',JSON.stringify(status));
 assert.equal(h.writes.length,1);assert.equal(h.writes[0].path,'/api/v1/sessions/legacy-session/messages/batch');
 assert.deepEqual(h.writes[0].data.messages[0].source_message_ids,['chatgpt:c1:u']);
 assert.equal(h.writes[0].data.messages[0].created_at,'2020-09-13T12:26:40.123456Z');
 assert.equal(h.local.ov_config.enabled,false);
 await h.send(await h.envelope('c1',2));
 await h.send({type:'V2_SAVE_CONFIG',config:{...config,namespace:'another-account'}},h.options);
 const changed=await h.send({type:'V2_STATUS',conversationId:'c1'},h.options);
 assert.equal(changed.conversation,null);assert.equal(h.writes.length,1);
});
test('enable requires explicit trust and stopped-uploader confirmations; URL credentials are refused',async()=>{
 const h=harness();
 assert.equal((await h.send({type:'V2_SAVE_CONFIG',config:{...config,enabled:true,legacyStopped:false}},h.options)).ok,false);
 assert.equal((await h.send({type:'V2_SAVE_CONFIG',config:{...config,enabled:true,sourceTrustAccepted:false}},h.options)).ok,false);
 const credentialUrl=['https://','user',':','secret','@','example.com'].join('');
 assert.equal((await h.send({type:'V2_SAVE_CONFIG',config:{...config,serverUrl:credentialUrl}},h.options)).ok,false);
 assert.equal(h.local.ov_v2_config,undefined);
});
const pagePayload=(id='c1')=>({id,kind:'page',body:JSON.stringify({
 messages:[{id:'old',author:{role:'user'},status:'finished_successfully',create_time:1500000000,
  content:{content_type:'text',parts:['Synthetic earlier question']}}],
 page_info:{has_previous_page:false,has_next_page:true,start_cursor:'old',end_cursor:'old'}
})});
test('complete worker accepts signed pagination only after same-document same-scope detail; repeat pages deduplicate',async()=>{
 const h=harness();await h.send({type:'V2_SAVE_CONFIG',config},h.options);await h.send({type:'V2_INIT'});
 assert.equal((await h.send(await h.envelope('c1',1,pagePayload()))).ok,false);
 assert.equal((await h.send(await h.envelope('c1',2))).ok,true);
 assert.equal((await h.send(await h.envelope('c1',3,pagePayload('c2')))).ok,false);
 assert.equal((await h.send(await h.envelope('c1',4,pagePayload()))).inserted,1);
 assert.equal((await h.send(await h.envelope('c1',5,pagePayload()))).inserted,0);
 const status=await h.send({type:'V2_STATUS',conversationId:'c1'},h.options);
 assert.equal(status.conversation.messageCount,2);assert.equal(status.conversation.queuedCount,2);
 assert.equal(status.conversation.title,'Synthetic');assert.equal(h.writes.length,0);
 // Even a fresh, valid channel on another tab cannot borrow this document's privacy context.
 const second={...h.sender,tab:{id:2},documentId:'second-document'};
 await h.send({type:'V2_INIT'},second);
 assert.equal((await h.send(await h.envelope('c1',1,pagePayload(),1),second)).ok,false);
 await h.send({type:'V2_SAVE_CONFIG',config:{...config,namespace:'other'}},h.options);
 assert.equal((await h.send(await h.envelope('c1',6,pagePayload()))).ok,false);
 assert.equal((await h.send({type:'V2_STATUS',conversationId:'c1'},h.options)).conversation,null);
});
test('privacy revocation invalidates page context and stores no excluded body',async()=>{
 for(const kind of ['detail','page']){
  const h=harness();await h.send({type:'V2_SAVE_CONFIG',config},h.options);await h.send({type:'V2_INIT'});
  await h.send(await h.envelope());
  const privatePayload={id:'c1',kind,body:JSON.stringify({conversation_id:'c1',is_temporary_chat:true,
   is_do_not_remember:false,title:'PRIVATE_TITLE',messages:[]})};
  assert.equal((await h.send(await h.envelope('c1',2,privatePayload))).excluded,true);
  assert.equal((await h.send(await h.envelope('c1',3,pagePayload()))).ok,false);
  assert.equal(JSON.stringify(h.session).includes('PRIVATE_TITLE'),false);
  assert.equal((await h.send({type:'V2_STATUS',conversationId:'c1'},h.options)).conversation.messageCount,1);
 }
});
test('pagination kind is authenticated; a tampered detail envelope cannot seed a page',async()=>{
 const h=harness();await h.send({type:'V2_INIT'});await h.send(await h.envelope());
 const signed=await h.envelope('c1',2,pagePayload());
 const changed=JSON.parse(signed.text);changed.id='c2';
 assert.equal((await h.send({...signed,text:JSON.stringify(changed)})).ok,false);
});
test('full worker uploads older mixed-text page into existing Session once and confirms by readback',async()=>{
 const h=harness();h.local.ov_config={...config};h.local.ov_sync_state={conversations:{c1:{sessionId:'legacy-session'}}};
 await h.send({type:'V2_SAVE_CONFIG',config},h.options);await h.send({type:'V2_INIT'});await h.send(await h.envelope());
 await h.send({type:'V2_SAVE_CONFIG',config:{...config,enabled:true}},h.options);
 async function synced(total){
  let s;for(let i=0;i<200;i++){
   await new Promise(r=>setImmediate(r));s=await h.send({type:'V2_STATUS',conversationId:'c1'},h.options);
   if(s.conversation?.messageCount===total&&s.conversation?.queuedCount===0&&s.conversation?.syncStatus==='synced')return s;
  }assert.fail(JSON.stringify(s));
 }
 await synced(1);
 const page=pagePayload(),data=JSON.parse(page.body);
 data.messages[0].content={content_type:'multimodal_text',parts:['Earlier question',{asset_pointer:'NOT_SENT'}]};
 page.body=JSON.stringify(data);
 assert.equal((await h.send(await h.envelope('c1',2,page))).inserted,1);
 const result=await synced(2);
 assert.equal(result.conversation.sessionId,'legacy-session');assert.equal(result.conversation.hasPartialContentHistory,true);
 assert.equal(h.writes.length,2);assert.equal(h.records.length,2);
 assert.deepEqual(h.records.map(r=>r.source_message_ids),[['chatgpt:c1:u'],['chatgpt:c1:old']]);
 assert.equal(h.records[1].content,'Earlier question');assert.equal(h.records[1].created_at,'2017-07-14T02:40:00Z');
 assert.equal(JSON.stringify(h.writes).includes('NOT_SENT'),false);
 assert.equal((await h.send(await h.envelope('c1',3,page))).inserted,0);
 await synced(2);assert.equal(h.writes.length,2);
});
test('14/24/120-message histories paginate beyond ten, preserve every source ID/time, and never re-upload overlapping pages',async()=>{
 for(const total of [14,24,120]){
  const h=harness();h.local.ov_config={...config};h.local.ov_sync_state={conversations:{c1:{sessionId:'legacy-session'}}};
  await h.send({type:'V2_SAVE_CONFIG',config},h.options);await h.send({type:'V2_INIT'});
  const messages=Array.from({length:total},(_,i)=>({id:'m'+i,author:{role:i%2?'assistant':'user'},
   status:'finished_successfully',create_time:1600000000+i,channel:i%2?'final':null,end_turn:i%2===1,
   metadata:i%2?{is_complete:true}:{},content:{content_type:'text',parts:['Synthetic message '+i]}}));
  let seq=0;
  async function capturePage(start,kind){
   const data={messages:messages.slice(start,start+10),page_info:{has_previous_page:start>0,has_next_page:start+10<total}};
   if(kind==='detail')Object.assign(data,{conversation_id:'c1',is_temporary_chat:false,is_do_not_remember:false,title:'Synthetic long conversation'});
   return h.send(await h.envelope('c1',++seq,{id:'c1',kind,body:JSON.stringify(data)}));
  }
  async function confirmed(n){
   let s;for(let i=0;i<500;i++){
    await new Promise(r=>setImmediate(r));s=await h.send({type:'V2_STATUS',conversationId:'c1'},h.options);
    if(s.conversation?.messageCount===n&&s.conversation?.queuedCount===0&&s.conversation?.syncStatus==='synced')return;
   }assert.fail(JSON.stringify(s));
  }
  const latest=total-10;await capturePage(latest,'detail');
  await h.send({type:'V2_SAVE_CONFIG',config:{...config,enabled:true}},h.options);await confirmed(10);
  let start=latest;
  while(start>0){start=Math.max(0,start-10);await capturePage(start,'page');await confirmed(total-start);}
  assert.equal(h.records.length,total);
  assert.equal(new Set(h.records.flatMap(r=>r.source_message_ids)).size,total);
  for(let i=0;i<total;i++){
   const row=h.records.find(r=>r.source_message_ids[0]==='chatgpt:c1:m'+i);
   assert.equal(row.content,'Synthetic message '+i);assert.equal(row.role,i%2?'assistant':'user');
   assert.equal(row.created_at,new Date((1600000000+i)*1000).toISOString().replace('.000Z','Z'));
  }
  const posts=h.writes.length;
  assert.equal((await capturePage(latest,'detail')).inserted,0);
  assert.equal((await capturePage(0,'page')).inserted,0);
  await confirmed(total);assert.equal(h.writes.length,posts);
 }
});
test('capture diagnostics retain only fixed error classification and stage, never private parse fragments',async()=>{
 const h=harness();await h.send({type:'V2_INIT'});
 const malformed={id:'c1',kind:'detail',body:'{"private":"DO_NOT_EXPORT_SECRET",invalid}'};
 const r=await h.send(await h.envelope('c1',1,malformed));
 assert.equal(r.ok,false);assert.equal(r.error,'SyntaxError');
 const status=await h.send({type:'V2_STATUS',conversationId:'c1'},h.options);
 assert.equal(status.captureError.stage,'capture');assert.equal(status.captureError.step,'parse_response');
 assert.equal(JSON.stringify(h.local).includes('DO_NOT_EXPORT_SECRET'),false);
});
test('capture errors are isolated by conversation and destination; unrelated successes cannot erase them',async()=>{
 const h=harness();await h.send({type:'V2_SAVE_CONFIG',config},h.options);await h.send({type:'V2_INIT'});
 const broken=id=>({id,body:'{"private":"NEVER_PERSIST",invalid}'});
 const status=id=>h.send({type:'V2_STATUS',conversationId:id},h.options);
 await h.send(await h.envelope('c1',1,broken('c1')));
 assert.equal((await status('c1')).captureError.error,'SyntaxError');
 assert.equal((await status('c2')).captureError,null);
 await h.send(await h.envelope('c2',2));
 assert.equal((await status('c1')).captureError.error,'SyntaxError');
 assert.equal((await status('c2')).captureError,null);
 await h.send(await h.envelope('c2',3,broken('c2')));
 await h.send(await h.envelope('c1',4));
 assert.equal((await status('c1')).captureError,null);
 assert.equal((await status('c2')).captureError.error,'SyntaxError');
 await h.send({type:'V2_SAVE_CONFIG',config:{...config,namespace:'other'}},h.options);
 assert.equal((await status('c2')).captureError,null);
 await h.send({type:'V2_SAVE_CONFIG',config},h.options);
 assert.equal((await status('c2')).captureError.error,'SyntaxError');
 assert.equal(JSON.stringify(h.local).includes('NEVER_PERSIST'),false);
});
test('queued failure followed by a successful capture does not leave a stale error',async()=>{
 const h=harness();await h.send({type:'V2_INIT'});
 const bad=await h.envelope('c1',1,{id:'c1',body:'invalid'}),good=await h.envelope('c1',2);
 const results=await Promise.all([h.send(bad),h.send(good)]);
 assert.equal(results[0].ok,false);assert.equal(results[1].ok,true);
 const s=await h.send({type:'V2_STATUS',conversationId:'c1'},h.options);
 assert.equal(s.captureError,null);assert.equal(s.conversation.messageCount,1);
});
test('injection failure records a fixed initialize step only for its source conversation',async()=>{
 const h=harness({injectionError:Error('PRIVATE_CHROME_ERROR_DETAILS')});
 assert.equal((await h.send({type:'V2_INIT'})).ok,false);
 const a=await h.send({type:'V2_STATUS',conversationId:'c1'},h.options);
 const b=await h.send({type:'V2_STATUS',conversationId:'c2'},h.options);
 assert.equal(a.captureError.stage,'initialize');assert.equal(a.captureError.step,'install_bridge');
 assert.equal(a.captureError.error,'capture_or_storage_failed');assert.equal(b.captureError,null);
 assert.equal(JSON.stringify(h.local).includes('PRIVATE_CHROME_ERROR_DETAILS'),false);
});
