'use strict';
let id=null,busy=false;
async function refresh(){
 if(busy)return;busy=true;
 try{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  id=tab?.url?.match(/^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\/([a-zA-Z0-9_-]+)/)?.[1]||null;
  const r=await chrome.runtime.sendMessage({type:'V2_STATUS',conversationId:id});if(!r.ok)throw Error(r.error);
  const c=r.conversation;
  let label=!r.configured?'OpenViking 未配置':!r.enabled?'自动同步已关闭':!c?'尚未取得消息，等待自然详情响应':
   c.lastError?'同步失败，可重试':c.conflictCount?'部分消息存在来源冲突':c.missingTimeCount?'部分消息缺少有效源时间':
   c.syncStatus==='syncing'?'同步中':c.queuedCount?'已采集，等待上传':c.messageCount?'已同步采集范围':'尚未取得支持的消息';
  document.getElementById('headline').textContent=label;
  document.getElementById('status').textContent=JSON.stringify({会话:id||'请在 ChatGPT 会话页打开',
   已采集:c?.messageCount||0,待上传:c?.queuedCount||0,来源冲突:c?.conflictCount||0,缺少源时间:c?.missingTimeCount||0,
   曾发现未支持内容:c?.hasUnsupportedHistory||false,远端重复:c?.duplicateCount||0,
   远端时间差异:c?.timeMismatchCount||0,自动整理提示:c?.policyWarning||null,
   最后采集:c?new Date(c.lastObservedAt).toLocaleString():null,
   最后确认:c?.lastSyncedAt?new Date(c.lastSyncedAt).toLocaleString():null,
   下次重试:c?.lastError&&c.nextRetryAt?new Date(c.nextRetryAt).toLocaleString():null,
   错误:c?.lastError||r.captureError?.error||null,范围:c?.lastPage||'未知'},null,2);
 }catch(e){document.getElementById('headline').textContent='状态读取失败';}finally{busy=false;}
}
document.getElementById('settings').onclick=()=>chrome.runtime.openOptionsPage();
document.getElementById('retry').onclick=async()=>{await chrome.runtime.sendMessage({type:'V2_RETRY',conversationId:id});void refresh();};
void refresh();setInterval(()=>{void refresh();},3000);
