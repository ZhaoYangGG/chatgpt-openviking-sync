'use strict';
const el=id=>document.getElementById(id),text=(id,value)=>{const node=el(id);if(node.textContent!==String(value))node.textContent=String(value);};
let id=null,tabId=null,busy=false,acting=false,view=null,readFailed=false;
const date=value=>value?new Date(value).toLocaleString(undefined,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'尚无记录';
async function deadline(promise){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),5000);})]);}finally{clearTimeout(timer);}
}
function buttons(){el('retry').disabled=acting||readFailed||!view?.canRetry;el('reload').disabled=acting||readFailed||!view?.canReload;}
async function refresh(){
 if(busy||acting)return;busy=true;
 try{
  const [tab]=await deadline(chrome.tabs.query({active:true,currentWindow:true}));
  id=OpenVikingSyncStatus.conversationId(tab?.url);tabId=tab?.id;
  const r=await deadline(chrome.runtime.sendMessage({type:'V2_STATUS',conversationId:id}));
  if(!r?.ok)throw Error('status_failed');
  const c=r.conversation||{};view=OpenVikingSyncStatus.present(r,id);
  if(readFailed)text('notice','');readFailed=false;
  el('hero').dataset.tone=view.tone;text('headline',view.title);text('detail',view.detail);
  text('conversation',id?view.titleText:'未选择 ChatGPT 会话');
  text('collected',view.total);text('confirmed',view.confirmed);text('queued',view.queued);
  text('history-title',id?view.history.title:'打开会话后查看范围');text('history-detail',id?view.history.detail:'这里会区分采集范围与上传进度。');text('next',view.next);
  el('warnings').replaceChildren(...view.warnings.map(value=>{const p=document.createElement('p');p.textContent=value;return p;}));
  el('warnings').hidden=!view.warnings.length;
  el('filtered').hidden=!view.filtered;text('filtered',`本次另过滤 ${view.filtered} 个系统、隐藏、内部、工具或 thoughts 节点，不计入正文同步数量。`);
  text('observed',date(c.lastObservedAt));text('synced',date(c.lastSyncedAt));
  const retry=!!(c.lastError&&c.nextRetryAt);el('retry-label').hidden=el('retry-time').hidden=!retry;
  text('retry-time',retry?`${date(c.nextRetryAt)} 起（后台唤醒时）`:'—');
  text('status',JSON.stringify({conversationId:id,sessionId:c.sessionId||null,status:view.key,page:c.lastPage||null,
   captureSummary:c.captureSummary||null,conflicts:c.conflictCount||0,missingTime:c.missingTimeCount||0,
   remoteDuplicates:c.duplicateCount||0,remoteTimeDifferences:c.timeMismatchCount||0,
   policyWarning:c.policyWarning||null,error:c.lastError||r.captureError?.error||null,
   captureStage:r.captureError?.stage||null,captureStep:r.captureError?.step||null},null,2));
 }catch{
  readFailed=true;el('hero').dataset.tone='warn';text('headline','暂时无法读取状态');
  text('detail','后台未及时响应；已有数字可能过时，不能据此判断当前是否同步。');
  text('next','请稍候，弹窗会自动重试读取；持续失败时可在扩展管理页检查错误。');
  text('notice','读取状态失败，将自动重试。');
 }finally{busy=false;buttons();}
}
el('version').textContent=`V${chrome.runtime.getManifest().version} · 同步状态`;
el('settings').onclick=()=>{chrome.runtime.openOptionsPage().catch(()=>text('notice','无法打开设置，请从扩展管理页进入。'));};
el('retry').onclick=async()=>{
 if(!view?.canRetry||acting)return;acting=true;buttons();
 try{const r=await deadline(chrome.runtime.sendMessage({type:'V2_RETRY',conversationId:id}));if(!r?.ok)throw Error();text('notice','已请求重试；是否成功以下方更新后的状态为准。');}
 catch{text('notice','未能发起重试，请稍后再试。');}finally{acting=false;void refresh();}
};
el('reload').onclick=async()=>{
 if(!view?.canReload||acting)return;
 if(!confirm('刷新可能中断正在生成的回复或影响未发送的草稿。请先保存草稿并等待回复完成。现在刷新此 ChatGPT 会话吗？'))return;
 acting=true;buttons();
 try{
  const tab=await deadline(chrome.tabs.get(tabId));if(OpenVikingSyncStatus.conversationId(tab.url)!==id)throw Error();
  await deadline(chrome.tabs.reload(tabId));text('notice','已请求刷新，等待 ChatGPT 发出新的详情响应；刷新本身不代表已同步。');
 }catch{text('notice','页面已切换或无法刷新，请回到目标会话手动刷新。');}finally{acting=false;void refresh();}
};
void refresh();
const interval=setInterval(()=>{if(!document.hidden)void refresh();},3000);
window.addEventListener('pagehide',()=>clearInterval(interval));
