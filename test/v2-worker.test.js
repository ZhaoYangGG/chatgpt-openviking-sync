'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const path=require('node:path');
function harness(){
  let listener;const writes=[],ingests=[];
  const ctx=vm.createContext({URL,Date,TextEncoder,Set,JSON,Error,Promise,
    importScripts(){},OpenVikingDetailParser:require('../src/capture/parser'),
    OpenVikingMessageStore:{MessageStore:class{async ingest(scope,data){ingests.push({scope,data});return {inserted:0};}}},
    chrome:{runtime:{getURL:p=>`chrome-extension://preview/${p}`,onMessage:{addListener:fn=>{listener=fn;}}},
      storage:{local:{set:async data=>writes.push(data)}},action:{setBadgeText:async()=>{}}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/background/v2-service-worker.js'),'utf8'),ctx);
  return {writes,ingests,send(message,sender={frameId:0,tab:{id:1},url:'https://chatgpt.com/c/c1'}){
    return new Promise(resolve=>{if(!listener(message,sender,resolve))resolve({ignored:true});});}};
}
test('V2 worker: foreign/subframe capture is ignored without persistence',async()=>{
  const h=harness();for(const sender of [{url:'https://other.example',tab:{id:1},frameId:0},{url:'https://chatgpt.com',tab:{id:1},frameId:1}])
    assert.equal((await h.send({type:'V2_CAPTURE',body:'{}'},sender)).ignored,true);
  assert.equal(h.writes.length,0);assert.equal(h.ingests.length,0);
});
test('V2 worker: mismatched payload is a safe error, never a stored conversation',async()=>{
  const h=harness();const r=await h.send({type:'V2_CAPTURE',conversationId:'c1',body:JSON.stringify({conversation_id:'c2',private:'DO_NOT_PERSIST'})});
  assert.equal(r.ok,false);assert.equal(h.ingests.length,0);assert.equal(JSON.stringify(h.writes).includes('DO_NOT_PERSIST'),false);
});
test('V2 worker: private response does not leak title/text into status storage',async()=>{
  const h=harness();await h.send({type:'V2_CAPTURE',conversationId:'c1',body:JSON.stringify({conversation_id:'c1',is_temporary_chat:true,title:'PRIVATE_TITLE'})});
  assert.equal(h.ingests[0].data.excluded,true);assert.equal(JSON.stringify(h.writes).includes('PRIVATE_TITLE'),false);assert.equal(h.writes.length,0);
});
test('V2 preview manifest: MAIN bridge only, no DOM poller or upload permissions',()=>{
  const m=require('../manifest.v2-preview.json');assert.equal(m.content_scripts[0].world,'MAIN');
  assert.equal(m.content_scripts[1].world,'ISOLATED');assert.deepEqual(m.permissions,['activeTab','storage']);
  assert.ok(m.content_security_policy.extension_pages.includes("connect-src 'none'"));
  const root=path.join(__dirname,'..');
  for(const file of [...m.content_scripts.flatMap(x=>x.js),m.background.service_worker,m.action.default_popup])assert.ok(fs.existsSync(path.join(root,file)));
  assert.ok(!JSON.stringify(m).includes('src/content/content.js'));
  assert.ok(!JSON.stringify(m).includes('openviking-client'));
});
