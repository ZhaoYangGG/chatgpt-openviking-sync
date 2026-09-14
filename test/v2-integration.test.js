'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const {MessageStore}=require('../src/background/message-store');
function harness(){
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
   scripting:{executeScript:async args=>{injections.push(args);return [{result:'installed'}];}},
   runtime:{getURL:p=>'chrome-extension://unit/'+p,onMessage:{addListener:f=>{listener=f;}},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
   alarms:{create:async()=>{},onAlarm:{addListener(){}}}
  }});
 vm.runInContext(fs.readFileSync(require.resolve('../src/background/v2-sync-worker'),'utf8'),context);
 const sender={frameId:0,tab:{id:1},documentId:'synthetic-document',url:'https://chatgpt.com/c/c1'};
 const options={url:'chrome-extension://unit/src/options/v2-options.html'};
 async function send(m,s=sender){return new Promise(resolve=>{if(!listener(m,s,resolve))resolve({ignored:true});});}
 async function envelope(id='c1',seq=1){
  const [secret,channel]=injections[0].args;
  const body=JSON.stringify({conversation_id:id,is_temporary_chat:false,is_do_not_remember:false,title:'Synthetic',
   messages:[{id:'u',author:{role:'user'},status:'finished_successfully',create_time:1600000000.123456,
    content:{content_type:'text',parts:['Synthetic text']}}]});
  const text=JSON.stringify({id,body});
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
