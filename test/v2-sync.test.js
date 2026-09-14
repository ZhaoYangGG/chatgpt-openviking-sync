'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const {MessageStore}=require('../src/background/message-store');
const {SyncEngine}=require('../src/background/sync-engine');
const {reconcile}=require('../src/background/reconcile');
const time=require('../src/shared/source-time'),parser=require('../src/capture/parser');
const {verify}=require('../src/background/capture-auth'),{install}=require('../src/capture/signed-bridge');
function detail(ids=['u','a']){
 return {conversationId:'c1',title:'Synthetic',excluded:false,returnedPageSupported:true,omissions:[],pageInfo:null,
  messages:ids.map((id,i)=>({id,sourceMessageId:'chatgpt:c1:'+id,role:i%2?'assistant':'user',content:'Synthetic '+id,
   parts:['Synthetic '+id],sourceIndex:i,createTime:1600000000+i,createTimeDecimal:'160000000'+i+'.123456789',
   updateTime:null,turnId:'synthetic-turn'}))};
}
async function harness(){
 const store=new MessageStore({indexedDB:new IDBFactory(),keyRange:IDBKeyRange});
 await store.ingest('scope',detail());
 let records=[],posts=0,failAfterWrite=false,failRead=false,changeCount=false;
 const client={
  async getSession(){return {total_message_count:records.length+(changeCount?1:0),auto_commit_policy:null};},
  async ensureSession(){return this.getSession();},
  async updateSessionConfig(){return {auto_commit_policy:null};},
  async readSessionMessages(){if(failRead)throw Error('offline');return structuredClone(records);},
  async addMessages(s,c,items){posts++;records.push(...items.map(i=>({sourceMessageId:i.sourceMessageId,role:i.role,content:i.content,createdAt:i.createdAt})));
   if(failAfterWrite)throw Error('lost_ack');}
 };
 const engine=new SyncEngine({store,client,reconcile,toIso:time.toIso,now:()=>10000});
 return {store,client,engine,get records(){return records;},get posts(){return posts;},
  setRecords:r=>{records=r;},loseAck:v=>{failAfterWrite=v;},readFail:v=>{failRead=v;},unstable:v=>{changeCount=v;}};
}
const config={autoCommitEnabled:false};
test('exact time parser retains all digits and ignores similarly named text',()=>{
 const raw='{"messages":[{"create_time":1600000000.123456789,"update_time":1.600000001123456e9,"content":"create_time: 999"}]}';
 const r=time.parseExact(raw);assert.equal(r.times.get('0:create_time'),'1600000000.123456789');
 assert.equal(time.toIso(r.times.get('0:create_time')),'2020-09-13T12:26:40.123456789Z');
 assert.equal(time.toIso(r.times.get('0:update_time')),'2020-09-13T12:26:41.123456Z');
 assert.throws(()=>time.toIso(null));assert.throws(()=>time.toIso('-1'));assert.throws(()=>time.toIso('1e100'));
});
test('exact parser rejects duplicate keys/depth and keeps null unknown',()=>{
 assert.throws(()=>time.parseExact('{"messages":[],"messages":[]}'),/duplicate/);
 assert.throws(()=>time.parseExact('['.repeat(66)+'0'+']'.repeat(66)),/depth/);
 assert.equal(time.parseExact('{"messages":[{"create_time":null}]}').times.size,0);
});
test('formal parser connects exact message lexeme rather than conversation fallback',()=>{
 const raw='{"conversation_id":"c1","is_temporary_chat":false,"is_do_not_remember":false,"create_time":10,"messages":[{"id":"u","author":{"role":"user"},"status":"finished_successfully","content":{"content_type":"text","parts":["synthetic"]},"create_time":1600000000.123456789}]}';
 assert.equal(parser.parseText(raw,'c1').messages[0].createTimeDecimal,'1600000000.123456789');
 assert.equal(parser.parseText(raw.replace('1600000000.123456789','null'),'c1').messages[0].createTimeDecimal,null);
});
test('engine writes once with bare client IDs, exact time and durable confirmation',async()=>{
 const h=await harness();await h.engine.run('scope','c1',config);
 assert.equal(h.posts,1);assert.equal(h.records[0].sourceMessageId,'u');
 assert.equal(h.records[0].createdAt,'2020-09-13T12:26:40.123456789Z');
 let c=await h.store.getConversation('scope','c1');assert.equal(c.queuedCount,0);assert.equal(c.pendingBatch,null);
 await h.store.ingest('scope',detail());await h.engine.run('scope','c1',config,{force:true});assert.equal(h.posts,1);
});
test('lost acknowledgement resumes by readback after store/engine reopen, never resends',async()=>{
 const h=await harness();h.loseAck(true);await h.engine.run('scope','c1',config);
 assert.ok((await h.store.getConversation('scope','c1')).pendingBatch);assert.equal(h.posts,1);
 const reopened=new MessageStore({indexedDB:h.store.idb,keyRange:IDBKeyRange});
 const engine=new SyncEngine({store:reopened,client:h.client,reconcile,toIso:time.toIso});
 await engine.run('scope','c1',config,{force:true});
 assert.equal(h.posts,1);assert.equal((await reopened.getConversation('scope','c1')).queuedCount,0);
});
test('remote physical duplicates are marked and confirmed, not frozen or re-appended',async()=>{
 const h=await harness();const r={sourceMessageId:'u',role:'user',content:'Synthetic u',createdAt:time.toIso('1600000000.123456789')};
 h.setRecords([r,r]);await h.engine.run('scope','c1',config);
 assert.equal(h.posts,1);assert.equal(h.records.length,3);
 const c=await h.store.getConversation('scope','c1');assert.equal(c.duplicateCount,1);assert.equal(c.queuedCount,0);
});
test('remote body conflict isolates only one record; other candidates continue',async()=>{
 const h=await harness();h.setRecords([{sourceMessageId:'u',role:'user',content:'different'}]);
 await h.engine.run('scope','c1',config);const c=await h.store.getConversation('scope','c1');
 assert.equal(c.conflictCount,1);assert.equal(c.queuedCount,0);assert.equal(h.records.length,2);
});
test('partial/moving log never permits writes, and offline schedules bounded retry',async()=>{
 for(const mode of ['unstable','readFail']){
  const h=await harness();h[mode](true);await h.engine.run('scope','c1',config);
  assert.equal(h.posts,0);const c=await h.store.getConversation('scope','c1');assert.equal(c.syncStatus,'error');assert.ok(c.nextRetryAt>10000);
 }
});
test('foreign identity blocks migration before sending unrelated conversation content',async()=>{
 const h=await harness();h.setRecords([{sourceMessageId:'',role:'user',content:'foreign'}]);
 await h.engine.run('scope','c1',config);assert.equal(h.posts,0);
 assert.equal((await h.store.getConversation('scope','c1')).lastError,'session_identity_conflict');
});
test('missing source time is isolated without fallback; later exact metadata can recover',async()=>{
 const h=await harness(),d=detail();d.messages[0].createTimeDecimal=null;
 await h.store.ingest('scope',d);await h.engine.run('scope','c1',config);
 let c=await h.store.getConversation('scope','c1');assert.equal(c.missingTimeCount,1);assert.equal(h.records.length,1);
 await h.store.ingest('scope',detail());await h.engine.run('scope','c1',config,{force:true});
 c=await h.store.getConversation('scope','c1');assert.equal(c.missingTimeCount,0);assert.equal(h.records.length,2);
});
test('legacy remote timestamps are diagnosed, never silently overwritten or duplicated',async()=>{
 const h=await harness();h.setRecords([{sourceMessageId:'u',role:'user',content:'Synthetic u',createdAt:'2020-01-01T00:00:00Z'}]);
 await h.engine.run('scope','c1',config);assert.equal(h.records.length,2);
 assert.equal((await h.store.getConversation('scope','c1')).timeMismatchCount,1);
});
test('disable guard prevents any network mutation',async()=>{
 const h=await harness();h.engine.isEnabled=async()=>false;
 await h.engine.run('scope','c1',config);assert.equal(h.posts,0);
});
test('capture revision during POST cannot be marked synced by old acknowledgement',async()=>{
 const h=await harness(),add=h.client.addMessages;
 h.client.addMessages=async(...args)=>{await add(...args);const d=detail();d.messages[0].content='edited';await h.store.ingest('scope',d);};
 await h.engine.run('scope','c1',config);
 const [row]=await h.store.getRows('scope','c1',['u']);assert.equal(row.status,'conflict');
});
test('two concurrent device stores converge after a race without indefinite duplicate retries',async()=>{
 const h=await harness(),other=new MessageStore({indexedDB:new IDBFactory(),keyRange:IDBKeyRange});
 await other.ingest('scope',detail());
 const e=new SyncEngine({store:other,client:h.client,reconcile,toIso:time.toIso});
 await Promise.all([h.engine.run('scope','c1',config),e.run('scope','c1',config)]);
 await h.engine.run('scope','c1',config,{force:true});await e.run('scope','c1',config,{force:true});
 const count=h.posts;await h.engine.run('scope','c1',config,{force:true});await e.run('scope','c1',config,{force:true});
 assert.equal(h.posts,count);assert.equal((await other.getConversation('scope','c1')).queuedCount,0);
});
test('signed bridge preserves native Promise, emits verifiable envelope and no secret',async()=>{
 const secret=Array.from(crypto.getRandomValues(new Uint8Array(32))),channel='synthetic-channel';
 let done;const received=new Promise(resolve=>{done=resolve;});
 const response=new Response('{"synthetic":true}',{headers:{'content-type':'application/json'}}),original=Promise.resolve(response);
 const context=vm.createContext({fetch:()=>original,crypto,URL,TextEncoder,TextDecoder,Uint8Array,setTimeout,clearTimeout,
  location:{href:'https://chatgpt.com/c/c1'},postMessage:e=>done(e)});
 vm.runInContext('('+install.toString()+')('+JSON.stringify(secret)+',"'+channel+'")',context);
 assert.equal(context.fetch('/backend-api/conversations/c1'),original);
 const envelope=await received,entry={secret,channel,lastSeq:0};
 assert.equal(await verify(envelope,entry),true);assert.equal(JSON.stringify(envelope).includes(JSON.stringify(secret)),false);
 assert.equal(await verify({...envelope,text:envelope.text+' '},entry),false);
 assert.equal(await verify({...envelope,mac:'0'.repeat(64)},entry),false);
 assert.equal(await verify(envelope,{...entry,lastSeq:envelope.seq}),false);
 assert.equal(await verify(envelope,{...entry,channel:'other-document'}),false);
 assert.deepEqual(await response.json(),{synthetic:true});
});
test('unsigned valid-looking page payload is rejected before parsing or storage',async()=>{
 assert.equal(await verify({text:'{"id":"c1","body":"{}"}',seq:1},null),false);
 assert.equal(await verify({text:'{}',seq:1,channel:'c',mac:'0'.repeat(64)},{secret:new Array(32).fill(0),channel:'c',lastSeq:0}),false);
});
test('client timeout covers stalled response body, not just response headers',async()=>{
 const {OpenVikingClient}=require('../src/background/openviking-client');
 const client=new OpenVikingClient({serverUrl:'https://example.com'},{timeoutMs:10,fetch:async(u,o)=>({ok:true,status:200,
  text:()=>new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>reject(Error('aborted'))))})});
 await assert.rejects(client.testConnection(),e=>e.code==='NETWORK_ERROR'&&e.retryable===true);
});
