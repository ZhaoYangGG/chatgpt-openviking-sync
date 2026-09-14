'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseDetail,compareDom}=require('../poc/chrome-capture/parser.js');
function fixture() {
  const base=(id,role,type='text')=>({id,author:{role},content:{content_type:type,parts:[`${role}: ${id}`]},
    create_time:100,update_time:null,status:'finished_successfully',end_turn:null,channel:null,recipient:'all',metadata:{}});
  const final=id=>({...base(id,'assistant'),channel:'final',end_turn:true,metadata:{is_complete:true,resolved_model_slug:'actual-model',turn_exchange_id:'turn-1'}});
  return {conversation_id:'c1',title:'Synthetic P0 fixture',is_temporary_chat:false,is_do_not_remember:false,
    page_info:{start_cursor:'s1',end_cursor:'a2',has_previous_page:false,has_next_page:false},messages:[
      ...[1,2,3,4].map(i=>base(`s${i}`,'system')),base('u1','user'),base('r1','assistant','model_editable_context'),
      base('r2','assistant','reasoning_recap'),final('a1'),base('u2','user'),base('r3','assistant','reasoning_recap'),final('a2')]};
}
test('P0: 11 nodes produce exactly 4 visible messages, not reasoning',()=>{
  const result=parseDetail(fixture(),'c1');assert.deepEqual(result.messages.map(m=>m.id),['u1','a1','u2','a2']);
  assert.deepEqual(result.counts,{system:4,hidden:0,internal:3,incomplete:0,unsupported:0});
  assert.equal(result.messages[0].sourceMessageId,'chatgpt:c1:u1');assert.equal(result.fullHistoryVerified,false);
});
test('P0: source order, raw fractions, missing time and whitespace preserved',()=>{
  const f=fixture();f.messages[4].create_time=1600000000.123456;f.messages[7].create_time=12;f.messages[8].create_time=null;
  f.messages[4].content.parts=['  a\n','b  '];const r=parseDetail(f,'c1');
  assert.deepEqual(r.messages.map(m=>m.id),['u1','a1','u2','a2']);assert.equal(r.messages[0].content,'  a\nb  ');
  assert.equal(r.messages[0].createTimeDecimal,'1600000000.123456');assert.equal(r.messages[2].createTime,null);
});
test('P0: privacy exclusions and unknown flags have no text',()=>{
  for(const field of ['is_temporary_chat','is_do_not_remember']) for(const val of [true,undefined]) {
    const f=fixture();f[field]=val;const r=parseDetail(f,'c1');assert.equal(r.excluded,true);assert.deepEqual(r.messages,[]);
    assert.equal(JSON.stringify(r).includes('Synthetic'),false);
  }
});
test('P0: can_save=false does not discard User; incomplete final is not accepted',()=>{
  const f=fixture();f.messages[4].metadata.can_save=false;f.messages[7].metadata.is_complete=false;
  const r=parseDetail(f,'c1');assert.deepEqual(r.messages.map(m=>m.id),['u1','u2','a2']);assert.equal(r.counts.incomplete,1);
});
test('P0: unknown/multipart content flags incomplete capture, not silent success',()=>{
  const f=fixture();f.messages[4].content.parts.push({asset_pointer:'not-downloaded'});
  const r=parseDetail(f,'c1');assert.equal(r.returnedPageSupported,false);assert.equal(r.counts.unsupported,1);
});
test('P0: cross-conversation and duplicate IDs rejected',()=>{
  assert.throws(()=>parseDetail(fixture(),'other'),/mismatch/);
  const f=fixture();f.messages[8].id='u1';assert.throws(()=>parseDetail(f,'c1'),/duplicate/);
});
test('P0: default model never masquerades as actual; no fabricated turn',()=>{
  const f=fixture();f.default_model_slug='default';const r=parseDetail(f,'c1');
  assert.equal(r.messages[0].actualModel,null);assert.equal(r.messages[0].turnId,null);assert.equal(r.messages[1].actualModel,'actual-model');
});
test('P0: subset DOM comparison does not label unloaded API messages as mismatched IDs',()=>{
  assert.equal(compareDom(['u','a'],['u']).conclusion,'all_current_dom_ids_match_api_subset');
  assert.equal(compareDom(['u'],[]).conclusion,'no_dom_ids');
  assert.equal(compareDom(['u'],['x']).conclusion,'differences_need_review');
});
function bridgeHarness(nativeFetch) {
  const emitted=[];let settle;
  const event=new Promise(resolve=>{settle=resolve;});
  const context=vm.createContext({fetch:nativeFetch,URL,Request,Response,TextDecoder,Date,Symbol,Reflect,
    performance:{timeOrigin:1},location:{href:'https://chatgpt.com/c/c1'},setTimeout,clearTimeout,
    postMessage:v=>{emitted.push(v);settle(v);}});
  vm.runInContext(fs.readFileSync(require.resolve('../poc/chrome-capture/bridge.js'),'utf8'),context);
  return {context,emitted,event};
}
test('P0 bridge: original promise and response body unchanged; installs only once',async()=>{
  const response=new Response(JSON.stringify(fixture()),{headers:{'content-type':'application/json'}}),p=Promise.resolve(response);
  const h=bridgeHarness(()=>p),fn=h.context.fetch;
  vm.runInContext(fs.readFileSync(require.resolve('../poc/chrome-capture/bridge.js'),'utf8'),h.context);assert.equal(h.context.fetch,fn);
  assert.equal(h.context.fetch('/backend-api/conversations/c1?num_turns=10'),p);
  const [original,event]=await Promise.all([p.then(r=>r.json()),h.event]);assert.equal(original.messages.length,11);
  assert.equal(JSON.parse(event.body).messages.length,11);
});
test('P0 bridge: unrelated requests, POST and external origins never cloned',async()=>{
  let clones=0;const p=Promise.resolve({clone(){clones++;throw Error('never');}});
  const h=bridgeHarness(()=>p);
  h.context.fetch('/backend-api/accounts');h.context.fetch('/backend-api/conversations/c1',{method:'POST'});
  h.context.fetch('https://other.example/backend-api/conversations/c1');await new Promise(r=>setImmediate(r));
  assert.equal(clones,0);assert.equal(h.emitted.length,0);
});
test('P0 bridge: HTML challenge is diagnostic only, not parsed or persisted',async()=>{
  const h=bridgeHarness(()=>Promise.resolve(new Response('<html>challenge</html>',{headers:{'content-type':'text/html'}})));
  h.context.fetch('/backend-api/conversations/c1');const e=await h.event;assert.equal(e.error,'not_successful_json');assert.equal(e.body,undefined);
});
test('P0 bridge: known oversized responses not cloned',async()=>{
  const h=bridgeHarness(()=>Promise.resolve(new Response('{}',{headers:{'content-type':'application/json','content-length':String(3*1024*1024)}})));
  h.context.fetch('/backend-api/conversations/c1');const e=await h.event;assert.equal(e.error,'capture_limit');assert.equal(e.body,undefined);
});
test('P0 bridge: preserves native rejection without unhandled capture errors',async()=>{
  const error=new Error('native failure'),p=Promise.reject(error);const h=bridgeHarness(()=>p);
  await assert.rejects(h.context.fetch('/backend-api/conversations/c1'),e=>e===error);assert.equal(h.emitted.length,0);
});
