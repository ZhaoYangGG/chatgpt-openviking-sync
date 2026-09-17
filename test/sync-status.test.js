'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const model=require('../src/shared/sync-status');
const present=(c={},extra={})=>model.present({configured:true,enabled:true,conversation:c,...extra},'c1');
test('status separates setup, pause, wrong page, waiting and confirmed observed range',()=>{
 assert.equal(present({}, {configured:false}).key,'unconfigured');
 assert.equal(present({}, {enabled:false}).key,'paused');
 assert.equal(model.present({configured:true,enabled:true},null).key,'no_conversation');
 assert.equal(present().key,'waiting');
 const v=present({messageCount:6});assert.equal(v.confirmed,6);assert.equal(v.key,'synced');
 assert.match(v.detail,/不代表完整历史/);assert.equal(v.canRetry,false);
});
test('status counts never include queued or isolated records in confirmations',()=>{
 const v=present({messageCount:10,queuedCount:3,conflictCount:2,missingTimeCount:1});
 assert.equal(v.confirmed,4);assert.equal(v.queued,3);assert.equal(v.key,'queued');assert.equal(v.canRetry,true);
 assert.equal(present({messageCount:10,conflictCount:2}).key,'partial');
 assert.equal(present({messageCount:1,queuedCount:1,syncStatus:'syncing'}).canRetry,false);
});
test('history only describes latest response; false flags never prove full history',()=>{
 const previous=present({messageCount:6,lastPage:{hasPreviousPage:true}});assert.match(previous.next,/向上滚动/);
 const completePage=present({messageCount:6,lastPage:{hasPreviousPage:false,hasNextPage:false}});
 assert.match(completePage.history.detail,/不是完整历史证明/);assert.match(completePage.next,/不需要/);
 assert.match(present({lastPage:{hasNextPage:true}}).history.title,/后续/);
 assert.match(present({messageCount:6,lastPage:{hasNextPage:true}}).next,/无需重复操作/);
 assert.match(present({lastPage:{}}).history.title,/不确定/);
});
test('errors, missing acknowledgements and excluded nodes cannot masquerade as clean green',()=>{
 assert.equal(present({messageCount:6,lastError:'HTTP_503'}).key,'error');
 assert.equal(present({messageCount:6},{captureError:{error:'failed'}}).key,'capture_error');
 assert.equal(present({messageCount:6,pendingBatch:{ids:['u']}}).key,'queued');
 const v=present({messageCount:6,captureSummary:{tools:3,internal:6,thoughts:1,system:1,nonFinal:3,unsupported:1},duplicateCount:2});
 assert.equal(v.filtered,11);assert.equal(v.tone,'warn');assert.equal(v.badge,'!');assert.equal(v.warnings.length,3);
 assert.equal(present({messageCount:6,captureSummary:{tools:3,internal:6}}).tone,'success');
 assert.match(present({messageCount:6,hasUnsupportedHistory:true}).warnings[0],/旧记录/);
});
test('conversation identity is exact origin and path, including custom GPTs',()=>{
 assert.equal(model.conversationId('https://chatgpt.com/g/test/c/abc?x=1'),'abc');
 for(const url of ['https://chatgpt.com.evil.invalid/c/abc','https://example.com/c/abc','https://chatgpt.com/c/abc/extra','https://chatgpt.com/','bad'])assert.equal(model.conversationId(url),null);
});
test('badge shares summaries across duplicate tabs, avoids unchanged repaints, clears on navigation',async()=>{
 const {create}=require('../src/background/status-badge');let tabs=[{id:1,url:'https://chatgpt.com/c/c1'},{id:2,url:'https://chatgpt.com/c/c1'}],reads=0;
 const calls=[];const chrome={tabs:{query:async()=>tabs},action:{setBadgeBackgroundColor:async()=>{},setTitle:async()=>{},setBadgeText:async v=>calls.push(v)}};
 const badge=create({chrome,statusModel:model,readStatus:async()=>{reads++;return {configured:true,enabled:true,conversation:{messageCount:6}};}});
 await badge.refresh();assert.equal(reads,1);assert.deepEqual(calls,[{tabId:1,text:'✓'},{tabId:2,text:'✓'}]);
 await badge.refresh();assert.equal(calls.length,2);
 tabs=[{id:1,url:'https://example.com'}];await badge.refresh();assert.deepEqual(calls.at(-1),{tabId:1,text:''});badge.dispose();
});
test('badge changes stale success to warning on store failure; event bursts are debounced',async()=>{
 const {create}=require('../src/background/status-badge');let failed=false,timers=0;const calls=[];
 const chrome={tabs:{query:async()=>[{id:1,url:'https://chatgpt.com/c/c1'}]},action:{setBadgeBackgroundColor:async()=>{},setTitle:async()=>{},setBadgeText:async v=>calls.push(v)}};
 const badge=create({chrome,statusModel:model,setTimer:()=>++timers,clearTimer:()=>{},readStatus:async()=>{if(failed)throw Error();return {configured:true,enabled:true,conversation:{messageCount:2}};}});
 await badge.refresh();failed=true;await badge.refresh();assert.equal(calls.at(-1).text,'!');
 badge.schedule();badge.schedule();badge.schedule();assert.equal(timers,1);badge.dispose();
});
test('zero accepted messages distinguish a received response from no capture',()=>{
 const v=present({lastObservedAt:123,lastNodeCount:5,messageCount:0,captureSummary:{unsupported:1,tools:1,thoughts:1}});
 assert.equal(v.key,'no_eligible');assert.match(v.title,/已收到/);assert.match(v.detail,/5 个/);
 assert.equal(v.tone,'warn');assert.equal(v.canRetry,false);
 assert.equal(present().key,'waiting');
 assert.equal(present({lastObservedAt:123,lastNodeCount:0}).key,'no_eligible');
});
test('partially captured multimodal text stays visibly incomplete across later pages',()=>{
 const v=present({messageCount:1,captureSummary:{partialText:1},hasPartialContentHistory:true});
 assert.equal(v.key,'synced');assert.equal(v.tone,'warn');assert.match(v.warnings[0],/仅保留文字/);
 const later=present({messageCount:2,captureSummary:{partialText:0},hasPartialContentHistory:true});
 assert.equal(later.tone,'warn');assert.match(later.warnings[0],/未同步/);
});
test('missing pagination privacy context has actionable fail-closed status',()=>{
 const v=present({messageCount:10},{captureError:{error:'pagination_context_missing'}});
 assert.equal(v.key,'capture_error');assert.match(v.title,/缺少会话验证/);assert.match(v.next,/再刷新/);
 assert.match(v.detail,/隐私保护未入库/);
});
