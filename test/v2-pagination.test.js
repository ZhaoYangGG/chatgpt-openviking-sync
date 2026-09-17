'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const parser=require('../src/capture/parser');
const {install}=require('../src/capture/signed-bridge');
const {verify}=require('../src/background/capture-auth');
const {MessageStore}=require('../src/background/message-store');
const fs=require('node:fs');
const message=(id,type='text',parts=[id])=>({id,author:{role:'user'},status:'finished_successfully',
 create_time:1600000000,content:{content_type:type,parts}});
const full=messages=>({conversation_id:'c1',title:'Synthetic title',is_temporary_chat:false,is_do_not_remember:false,messages});
const context={conversationId:'c1',privacyAllowed:true,title:'Synthetic title'};
test('page parser requires trusted context and rejects conflicting identity/privacy',()=>{
 const data={messages:[message('old')]};
 for(const c of [null,{}, {...context,conversationId:'c2'}, {...context,privacyAllowed:false}])
  assert.throws(()=>parser.parsePage(data,'c1',c),/pagination_context_missing/);
 assert.throws(()=>parser.parsePage({...data,conversation_id:'c2'},'c1',context),/mismatch/);
 for(const field of ['is_temporary_chat','is_do_not_remember'])for(const value of [true,null,0]){
  const r=parser.parsePage({...data,[field]:value},'c1',context);assert.equal(r.excluded,true);assert.deepEqual(r.messages,[]);
 }
 // Full details remain fail-closed: absence is not permission.
 assert.equal(parser.parseDetail({...data,conversation_id:'c1'},'c1').excluded,true);
});
test('pagination retains source order, title, boundaries and exact numeric timestamp lexemes',()=>{
 const body=JSON.stringify({messages:[message('z'),message('a')],page_info:{has_previous_page:false,
  has_next_page:true,start_cursor:'z',end_cursor:'a'}}).replaceAll('1600000000','1600000000.123456789');
 const r=parser.parseText(body,'c1',{kind:'page',context});
 assert.deepEqual(r.messages.map(m=>m.id),['z','a']);assert.equal(r.messages[0].createTimeDecimal,'1600000000.123456789');
 assert.equal(r.title,'Synthetic title');assert.equal(r.pageInfo.hasPreviousPage,false);
 assert.equal(r.fullHistoryVerified,false);assert.equal(r.messages[0].sourceMessageId,'chatgpt:c1:z');
 assert.throws(()=>parser.parseText(body,'c1',{kind:'other',context}),/invalid_capture_kind/);
});
test('mixed user text is retained verbatim, asset objects never persisted, image-only and tool output remain omitted',()=>{
 const r=parser.parseDetail(full([
  message('mixed','multimodal_text',['  before\n',{content_type:'image_asset_pointer',asset_pointer:'PRIVATE_ASSET'},'after  ']),
  message('image-only','multimodal_text',[{asset_pointer:'PRIVATE_ASSET'}]),
  {...message('tool','multimodal_text',['tool text']),author:{role:'tool'}},
  {...message('thoughts','thoughts',['internal']),author:{role:'assistant'}}
 ]),'c1');
 assert.equal(r.messages.length,1);assert.equal(r.messages[0].content,'  before\nafter  ');
 assert.deepEqual(r.messages[0].parts,['  before\n','after  ']);assert.equal(r.messages[0].partialContent,true);
 assert.equal(r.messages[0].omittedPartCount,1);assert.equal(r.counts.unsupported,3);
 assert.equal(r.returnedPageSupported,false);assert.equal(JSON.stringify(r).includes('PRIVATE_ASSET'),false);
 const bad=message('plain','text',['x',{text:'not accepted'}]);
 assert.equal(parser.parseDetail(full([bad]),'c1').messages.length,0);
});
test('detail + overlapping historical pages + reopened store enqueue each ID once without losing text-only warning',async()=>{
 const s=new MessageStore({indexedDB:new IDBFactory(),keyRange:IDBKeyRange});
 await s.ingest('scope',parser.parseDetail(full([message('new')]),'c1'));
 const page=parser.parsePage({messages:[message('old','multimodal_text',['question',{asset_pointer:'never stored'}]),message('new')]},'c1',context);
 assert.equal((await s.ingest('scope',page)).inserted,1);
 const reopened=new MessageStore({indexedDB:s.idb,keyRange:IDBKeyRange});
 assert.equal((await reopened.ingest('scope',page)).inserted,0);
 await reopened.ingest('scope',parser.parseDetail(full([message('new')]),'c1'));
 const c=await reopened.getConversation('scope','c1');
 assert.equal(c.messageCount,2);assert.equal(c.queuedCount,2);assert.equal(c.hasPartialContentHistory,true);
 assert.equal(c.title,'Synthetic title');assert.equal((await reopened.listOutbox('scope','c1')).length,2);
});
test('signed bridge captures only exact detail or messages endpoints and authenticates the endpoint kind',async()=>{
 const secret=Array.from(crypto.getRandomValues(new Uint8Array(32))),channel='synthetic-page-channel';
 const events=[];let resolve;const event=()=>new Promise(r=>{resolve=r;});let clones=0;
 const c=vm.createContext({crypto,URL,TextEncoder,TextDecoder,Uint8Array,setTimeout,clearTimeout,
  location:{href:'https://chatgpt.com/c/c1'},postMessage:e=>{events.push(e);resolve?.(e);},
  fetch:()=>{const r=new Response('{"messages":[]}',{headers:{'content-type':'application/json'}});
   const clone=r.clone.bind(r);r.clone=()=>{clones++;return clone();};return Promise.resolve(r);}});
 vm.runInContext('('+install.toString()+')('+JSON.stringify(secret)+','+JSON.stringify(channel)+')',c);
 for(const [url,kind] of [['/backend-api/conversations/c1?num_turns=10','detail'],
  ['/backend-api/conversations/c1/messages?before=old&num_turns=10','page'],['/backend-api/conversation/c1/messages/','page']]){
  const done=event();const r=await c.fetch(url);assert.deepEqual(await r.json(),{messages:[]});
  const e=await done;assert.equal(await verify(e,{secret,channel,lastSeq:0}),true);
  const payload=JSON.parse(e.text);assert.equal(payload.kind,kind);assert.equal(payload.id,'c1');
  assert.equal(Object.hasOwn(payload,'before'),false);
 }
 for(const url of ['/backend-api/conversations/c1/textdocs','/backend-api/conversations/c1/messages/extra',
  'https://other.example/backend-api/conversations/c1/messages'])await c.fetch(url);
 await c.fetch('/backend-api/conversations/c1/messages',{method:'POST'});
 await new Promise(r=>setImmediate(r));assert.equal(clones,3);assert.equal(events.length,3);
});
test('relay handles synchronous invalidation and async rejection during extension upgrade without uncaught errors',async()=>{
 for(const asyncFailure of [false,true]){
  const listeners={},calls=[],window={addEventListener:(name,fn)=>{listeners[name]=fn;}};
  const c=vm.createContext({window,Date,chrome:{runtime:{sendMessage:m=>{
   calls.push(m.type);if(asyncFailure)return Promise.reject(Error('Extension context invalidated.'));
   throw Error('Extension context invalidated.');
  }}}});
  assert.doesNotThrow(()=>vm.runInContext(fs.readFileSync(require.resolve('../src/capture/signed-relay'),'utf8'),c));
  const emit=()=>listeners.message({source:window,origin:'https://chatgpt.com',data:{type:'OV_V2_SIGNED',text:'{}'}});
  assert.doesNotThrow(emit);assert.doesNotThrow(emit);
  // Backlog and rate-limit reporting must be safe too.
  assert.doesNotThrow(()=>{for(let i=0;i<20;i++)emit();});
  await new Promise(r=>setImmediate(r));
  assert.ok(calls.includes('V2_INIT'));assert.ok(calls.includes('V2_SIGNED_CAPTURE'));assert.ok(calls.includes('V2_RELAY_ERROR'));
 }
});
