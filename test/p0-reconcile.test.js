'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reconcileSnapshot}=require('../poc/reconcile-snapshot');
const row=(id,content=id,extra={})=>({sourceMessageId:id,role:'user',content,...extra});
const run=(candidates,remoteRecords,reportedTotal=remoteRecords.length)=>reconcileSnapshot({conversationId:'c1',candidates,remoteRecords,reportedTotal});
test('P0 reconcile: physical duplicates confirmed once, unrelated messages still sent',()=>{
  const r=run([row('chatgpt:c1:a'),row('chatgpt:c1:b','b')],[row('a','chatgpt:c1:a'),row('a','chatgpt:c1:a')]);
  assert.equal(r.physicalCount,2);assert.equal(r.uniqueRemoteSources,1);
  assert.equal(r.duplicates.length,1);assert.deepEqual(r.confirmed,['chatgpt:c1:a']);
  assert.deepEqual(r.toSend.map(m=>m.sourceMessageId),['chatgpt:c1:b']);
});
test('P0 reconcile: lost confirmation and restart recover by readback without another send',()=>{
  const candidates=[row('a'),row('b')],remote=candidates.map(m=>({...m}));
  assert.equal(run(candidates,remote).toSend.length,0);
  assert.equal(run(JSON.parse(JSON.stringify(candidates)),remote).toSend.length,0);
});
test('P0 reconcile: metadata-only updates do not resend content',()=>{
  const r=run([row('a','hello',{updateTime:200,actualModel:'new'})],[row('a','hello',{updateTime:100})]);
  assert.equal(r.confirmed.length,1);assert.equal(r.toSend.length,0);
});
test('P0 reconcile: changed body/role quarantines only affected source',()=>{
  for(const changed of [row('a','revision'),row('a','a',{role:'assistant'})]) {
    const r=run([changed,row('b')],[row('a')]);
    assert.deepEqual(r.conflicts,['chatgpt:c1:a']);assert.deepEqual(r.toSend,[row('b')]);
  }
});
test('P0 reconcile: incomplete physical read never permits blind resend',()=>{
  for(const total of [null,undefined,2,-1,0])assert.equal(run([row('a')],[row('a')],total).toSend.length,0);
  assert.equal(run([row('b')],[row('a')],2).status,'needs_fresh_read');
});
test('P0 reconcile: overlapping pages merge by ID without sorting true timestamps',()=>{
  const r=run([row('a','a',{createTime:200}),row('b','b',{createTime:100}),row('a','a')],[]);
  assert.deepEqual(r.toSend.map(m=>m.sourceMessageId),['a','b']);
  const later=run([row('older','older',{createTime:1})],[row('a'),row('b')]);
  assert.equal(later.toSend[0].createTime,1);
});
test('P0 reconcile: cloud race exposes duplicates but cannot claim to prevent them',()=>{
  const candidate=[row('a')];
  const left=run(candidate,[]),right=run(candidate,[]);
  assert.equal(left.toSend.length,1);assert.equal(right.toSend.length,1);
  const after=run(candidate,[...left.toSend,...right.toSend]);
  assert.equal(after.toSend.length,0);assert.equal(after.duplicates[0].physicalCount,2);
  assert.equal(after.status,'best_effort');
});
test('P0 reconcile: V1 readback normalization and source namespaces are explicit',()=>{
  const r=run([row('chatgpt:c1:a','hello  \r\n')],[row('a','hello'),row('chatgpt:other:a','hello'),row(null,'manual')]);
  assert.equal(r.confirmed.length,1);assert.equal(r.foreignRecords,2);
  assert.equal(r.physicalCount,3);assert.equal(r.uniqueRemoteSources,1);
});
