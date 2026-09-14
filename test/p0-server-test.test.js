'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const core=require('../src/shared/core');
function harness({confirmPolicy=true,idempotent=false}={}) {
  const elements=new Map(),calls=[],sessions=new Map();
  const document={getElementById:id=>{if(!elements.has(id))elements.set(id,{disabled:false,textContent:''});return elements.get(id);}};
  class Client {
    async testConnection(){return {version:'mock-only'};}
    async getSession(id){if(!sessions.has(id))throw Object.assign(new Error('missing'),{httpStatus:404});return {session_id:id,auto_commit_policy:null,total_message_count:sessions.get(id).length};}
    async request(path,options){calls.push({path,...options});if(path==='/api/v1/sessions'){sessions.set(options.body.session_id,[]);return {};}
      if(path.endsWith('/config'))return confirmPolicy?{auto_commit_policy:null}:{};throw Error('unexpected_endpoint');}
    async readSessionMessages(id){return sessions.get(id).map(r=>({...r}));}
    async addMessages(id,_conversation,rows){calls.push({path:`${id}/messages`,rows});for(const row of rows){
      if(idempotent&&sessions.get(id).some(r=>r.sourceMessageId===row.sourceMessageId))continue;sessions.get(id).push({...row});}return {};}
  }
  const context=vm.createContext({document,OpenVikingSyncCore:core,OpenVikingClientModule:{OpenVikingClient:Client},
    chrome:{storage:{local:{get:async()=>({ov_config:{serverUrl:'https://example.com/openviking',apiKey:'DO_NOT_EXPORT_SECRET'}})}}},
    fetch:()=>{throw Error('real_network_forbidden');},Date,crypto:globalThis.crypto,Blob,URL,setTimeout,console});
  vm.runInContext(fs.readFileSync(require.resolve('../src/diagnostics/p0-server-test.js'),'utf8'),context);
  return {elements,calls,sessions,async run(){await elements.get('inspect').onclick();await elements.get('run').onclick();return JSON.parse(elements.get('output').textContent);}};
}
test('P0 server harness: safety response missing => no synthetic messages written',async()=>{
  const h=harness({confirmPolicy:false}),r=await h.run();assert.equal(r.status,'blocked_or_failed');
  assert.equal(h.calls.filter(c=>c.rows).length,0);assert.equal(h.sessions.size,1);
});
test('P0 server harness: append-only server detected, no commits/deletes/credentials exported',async()=>{
  const h=harness(),r=await h.run();assert.equal(r.status,'completed_available_tests');
  assert.equal(r.modeEvidence,'append_behavior_observed_best_effort_required');assert.ok(r.observedDuplicateIds.includes('repeat'));
  assert.ok(h.calls.every(c=>!c.path.includes('/commit')&&c.method!=='DELETE'));
  assert.equal(JSON.stringify(r).includes('DO_NOT_EXPORT_SECRET'),false);
  const create=h.calls.find(c=>c.path==='/api/v1/sessions');assert.equal(create.body.memory_policy.self.enabled,false);
  assert.equal(create.body.memory_policy.peer.enabled,false);assert.equal(create.body.auto_commit_policy,null);
});
test('P0 server harness: passing sample not presented as universal idempotency guarantee',async()=>{
  const h=harness({idempotent:true}),r=await h.run();assert.equal(r.status,'completed_available_tests');
  assert.equal(r.modeEvidence,'no_duplicates_in_this_test_not_a_contract');assert.ok(r.notTested.includes('archive_after_commit'));
});
