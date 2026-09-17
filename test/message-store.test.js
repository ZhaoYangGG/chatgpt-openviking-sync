'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const {MessageStore}=require('../src/background/message-store');
const {parseDetail}=require('../src/capture/parser');
const make=(opts={})=>new MessageStore({indexedDB:new IDBFactory(),keyRange:IDBKeyRange,...opts});
function detail(ids=['z','a'],{conv='c1',text,updateTime=1,times={}}={}){
  return {conversationId:conv,title:'Synthetic',excluded:false,returnedPageSupported:true,omissions:[],pageInfo:{hasPreviousPage:true,hasNextPage:false},
    messages:ids.map((id,i)=>({id,sourceMessageId:`chatgpt:${conv}:${id}`,role:i%2?'assistant':'user',
      content:text||id,parts:[text||id],sourceIndex:i,createTime:times[id]??i,updateTime,turnId:null}))};
}
test('V2 IDB: duplicate response, reopen and overlapping page enqueue once by real ID',async()=>{
  const s=make();await s.ingest('scope',detail());await s.ingest('scope',detail());
  const reopened=new MessageStore({indexedDB:s.idb,keyRange:IDBKeyRange});
  await reopened.ingest('scope',detail(['z']));
  const c=await reopened.getConversation('scope','c1');assert.equal(c.messageCount,2);assert.equal(c.queuedCount,2);
  assert.equal((await reopened.listOutbox('scope','c1')).length,2);
});
test('V2 IDB: two clients writing concurrently share atomic index/outbox transaction',async()=>{
  const s=make(),other=new MessageStore({indexedDB:s.idb,keyRange:IDBKeyRange});
  await Promise.all([s.ingest('scope',detail()),other.ingest('scope',detail())]);
  const c=await s.getConversation('scope','c1');assert.equal(c.messageCount,2);assert.equal(c.queuedCount,2);
});
test('V2 IDB: delivery order is source observation order, not UUID or timestamp order',async()=>{
  const s=make();await s.ingest('scope',detail(['z','a'],{times:{z:200,a:100}}));
  await s.ingest('scope',detail(['older'],{times:{older:1}}));
  assert.deepEqual((await s.listOutbox('scope','c1')).map(r=>r.key[2]),['z','a','older']);
  assert.equal((await s.listOutbox('scope','c1',1)).length,1);
});
test('V2 IDB: metadata-only change updates row, not outbox or body',async()=>{
  const s=make();await s.ingest('scope',detail());const before=await s.listOutbox('scope','c1');
  const result=await s.ingest('scope',detail(['z','a'],{updateTime:99}));
  assert.equal(result.updated,2);assert.equal(result.inserted,0);assert.deepEqual(await s.listOutbox('scope','c1'),before);
});
test('V2 IDB: changed source preserves revision and isolates just that record',async()=>{
  const s=make();await s.ingest('scope',detail());
  await s.ingest('scope',detail(['z'],{text:'changed'}));await s.ingest('scope',detail(['z'],{text:'changed'}));
  const c=await s.getConversation('scope','c1');assert.equal(c.conflictCount,1);assert.equal(c.queuedCount,1);
  assert.deepEqual((await s.listOutbox('scope','c1')).map(r=>r.key[2]),['a']);
  const count=await s.transaction(['revisions'],'readonly',tx=>new Promise(resolve=>{const r=tx.objectStore('revisions').count();r.onsuccess=()=>resolve(r.result);}));
  assert.equal(count,1);
});
test('V2 IDB: quota abort is atomic and never evicts existing unsent records',async()=>{
  const s=make();await s.ingest('scope',detail());s.maxBytes=1;
  await assert.rejects(s.ingest('scope',detail(['new'])),/storage_capacity_reached/);
  assert.equal((await s.getConversation('scope','c1')).messageCount,2);
  assert.equal((await s.listOutbox('scope','c1')).length,2);
});
test('V2 IDB: body whitespace is preserved and its changes are not metadata-only',async()=>{
  const s=make();await s.ingest('scope',detail(['z'],{text:'line  \nnext'}));
  const r=await s.ingest('scope',detail(['z'],{text:'line\nnext'}));assert.equal(r.conflicts,1);
  const stored=await s.transaction(['messages'],'readonly',tx=>new Promise(resolve=>{
    const request=tx.objectStore('messages').get(['scope','c1','z']);request.onsuccess=()=>resolve(request.result);
  }));assert.equal(stored.content,'line  \nnext');
});
test('V2 IDB: excluded/private response creates no message or conversation',async()=>{
  const s=make();await s.ingest('scope',{conversationId:'c1',excluded:true});
  assert.equal(await s.getConversation('scope','c1'),undefined);assert.deepEqual(await s.listOutbox('scope','c1'),[]);
});
test('V2 IDB: scope and conversation namespaces never merge unrelated IDs',async()=>{
  const s=make();await s.ingest('one',detail());await s.ingest('two',detail());
  await s.ingest('one',detail(['z'],{conv:'c2'}));
  assert.equal((await s.getConversation('one','c1')).messageCount,2);
  assert.equal((await s.getConversation('two','c1')).messageCount,2);
  assert.equal((await s.getConversation('one','c2')).messageCount,1);
});
test('V2 parser: multimodal_text and thoughts are explicit unsupported, not success',()=>{
  const result=parseDetail({conversation_id:'c1',is_temporary_chat:false,is_do_not_remember:false,
    messages:['multimodal_text','thoughts'].map((type,i)=>({id:`x${i}`,author:{role:'assistant'},content:{content_type:type,parts:['synthetic']}}))},'c1');
  assert.equal(result.counts.unsupported,2);assert.equal(result.returnedPageSupported,false);assert.equal(result.messages.length,0);
});
test('V2 IDB: latest capture classification separates internal filters from unsupported content',async()=>{
 const s=make(),d=detail();d.counts={system:1,hidden:2,internal:3};
 d.omissions=[{role:'tool',type:'text',reason:'unsupported'},{role:'assistant',type:'thoughts',reason:'unsupported'},
  {role:'assistant',type:'text',reason:'incomplete'},{role:'user',type:'multimodal_text',reason:'unsupported'}];
 d.returnedPageSupported=false;await s.ingest('scope',d);
 assert.deepEqual((await s.getConversation('scope','c1')).captureSummary,{system:1,hidden:2,internal:3,tools:1,thoughts:1,nonFinal:1,unsupported:1,partialText:0});
 await s.ingest('scope',detail());const c=await s.getConversation('scope','c1');
 assert.equal(c.captureSummary.unsupported,0);assert.equal(c.hasUnsupportedHistory,true);assert.equal(c.messageCount,2);
});
test('V2 IDB: missing-time to conflict remains one isolated record for status counters',async()=>{
 const s=make();await s.ingest('scope',detail(['z']));const [row]=await s.getRows('scope','c1',['z']);
 await s.updateSync('scope','c1',{},[{id:'z',contentHash:row.contentHash,status:'missing_time'}]);
 await s.ingest('scope',detail(['z'],{text:'changed'}));const c=await s.getConversation('scope','c1');
 assert.equal(c.missingTimeCount,0);assert.equal(c.conflictCount,1);assert.equal(c.queuedCount,0);
});
