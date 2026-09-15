'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const html=fs.readFileSync(require.resolve('../src/popup/v2-sync-popup.html'),'utf8');
const source=fs.readFileSync(require.resolve('../src/popup/v2-sync-popup.js'),'utf8');
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
function harness(initial){
 const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,{textContent:'',hidden:false,disabled:false,dataset:{},replaceChildren(...nodes){this.children=nodes;}}]));
 let response=initial,interval,confirmation=false,reloads=0,sent=[];const timers=new Map();let n=0;
 const tab={id:1,url:'https://chatgpt.com/c/c1'};
 const context=vm.createContext({OpenVikingSyncStatus:require('../src/shared/sync-status'),Date,Promise,JSON,Error,
  document:{hidden:false,getElementById:id=>elements[id],createElement:()=>({textContent:''})},window:{addEventListener(){}},
  setTimeout:f=>{timers.set(++n,f);return n;},clearTimeout:id=>timers.delete(id),setInterval:f=>{interval=f;return 1;},clearInterval(){},confirm:()=>confirmation,
  chrome:{tabs:{query:async()=>[tab],get:async()=>tab,reload:async()=>{reloads++;}},
   runtime:{getManifest:()=>({version:'0.2.2'}),openOptionsPage:async()=>{},sendMessage:async m=>{sent.push(m);return m.type==='V2_RETRY'?{ok:true}:response;}}}});
 vm.runInContext(source,context);
 return {elements,timers,tab,sent,get reloads(){return reloads;},setResponse:r=>{response=r;},tick:()=>interval(),confirm:()=>{confirmation=true;}};
}
test('popup renders counts and inert text, diagnostics folded, no no-op retry',async()=>{
 const h=harness({ok:true,configured:true,enabled:true,conversation:{title:'<img onerror=evil()>',messageCount:6,lastPage:{hasPreviousPage:false,hasNextPage:false}}});await settle();
 assert.equal(h.elements.confirmed.textContent,'6');assert.equal(h.elements.conversation.textContent,'<img onerror=evil()>');
 assert.equal(h.elements.retry.disabled,true);assert.equal(h.elements.reload.disabled,false);
 assert.match(h.elements.headline.textContent,/已采集内容已同步/);assert.match(html,/<details><summary>/);
 assert.equal(h.timers.size,0);
});
test('popup status timeout never leaves stale green; later refresh recovers',async()=>{
 const h=harness({ok:true,configured:true,enabled:true,conversation:{messageCount:6}});await settle();
 h.setResponse(new Promise(()=>{}));h.tick();await settle();for(const f of [...h.timers.values()])f();await settle();
 assert.equal(h.elements.hero.dataset.tone,'warn');assert.match(h.elements.headline.textContent,/无法读取/);assert.equal(h.elements.reload.disabled,true);
 h.setResponse({ok:true,configured:true,enabled:true,conversation:{messageCount:6}});h.tick();await settle();
 assert.equal(h.elements.hero.dataset.tone,'success');assert.equal(h.elements.notice.textContent,'');
});
test('popup retry reports request, not success; refresh requires confirmation and exact target',async()=>{
 const h=harness({ok:true,configured:true,enabled:true,conversation:{messageCount:6,queuedCount:2}});await settle();
 await h.elements.retry.onclick();await settle();assert.equal(h.sent.some(m=>m.type==='V2_RETRY'),true);assert.match(h.elements.notice.textContent,/已请求重试/);
 await h.elements.reload.onclick();assert.equal(h.reloads,0);
 h.confirm();h.tab.url='https://chatgpt.com/c/another';await h.elements.reload.onclick();await settle();assert.equal(h.reloads,0);
 h.tab.url='https://chatgpt.com/c/c1';h.tick();await settle();await h.elements.reload.onclick();await settle();assert.equal(h.reloads,1);
});
