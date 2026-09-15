(function(root,factory){
 const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.OpenVikingStatusBadge=api;
})(globalThis,function(){
 'use strict';
 const colors={neutral:'#627584',success:'#167352',busy:'#1768b3',warn:'#996200',error:'#b73535'};
 function create({chrome,statusModel,readStatus,setTimer=setTimeout,clearTimer=clearTimeout}){
  let timer=null,running=false,dirty=false;const painted=new Map();
  async function paint(tabId,view){
   const value={text:view?.badge||'',color:colors[view?.tone]||colors.neutral,
    title:view?`OpenViking · ${view.title}\n${view.total} 条采集 · ${view.confirmed} 条确认 · ${view.queued} 条待确认\n${view.next}`:'ChatGPT → OpenViking'};
   const signature=JSON.stringify(value);if(painted.get(tabId)===signature)return;
   try{
    await chrome.action.setBadgeBackgroundColor({tabId,color:value.color});
    await chrome.action.setBadgeText({tabId,text:value.text});
    await chrome.action.setTitle({tabId,title:value.title});painted.set(tabId,signature);
   }catch{painted.delete(tabId);}
  }
  async function refresh(){
   if(running){dirty=true;return;}running=true;dirty=false;
   try{
    const tabs=await chrome.tabs.query({}),cache=new Map(),seen=new Set();
    // Only read small conversation summaries, never message bodies or the page DOM.
    for(const tab of tabs){
     if(!Number.isInteger(tab.id))continue;seen.add(tab.id);
     const id=statusModel.conversationId(tab.url);
     if(!id){await paint(tab.id,null);continue;}
     if(!cache.has(id))cache.set(id,readStatus(id));
     const data=await cache.get(id);await paint(tab.id,statusModel.present(data,id));
    }
    for(const id of painted.keys())if(!seen.has(id))painted.delete(id);
   }catch{
    // Never leave a stale green checkmark when the status store becomes unreadable.
    for(const id of painted.keys())await paint(id,{badge:'!',tone:'warn',title:'状态暂不可读',total:'—',confirmed:'—',queued:'—',next:'打开弹窗查看，已有状态可能过时。'});
   }finally{running=false;if(dirty)schedule();}
  }
  function schedule(){dirty=true;if(timer!==null||running)return;timer=setTimer(()=>{timer=null;void refresh();},150);}
  function dispose(){if(timer!==null)clearTimer(timer);timer=null;}
  return {schedule,refresh,dispose};
 }
 return {create};
});
