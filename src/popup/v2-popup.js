'use strict';
async function refresh(){
  const output=document.getElementById('status');
  try{
    const small=await chrome.storage.local.get('v2LastCapture');
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const id=tab?.url?.match(/^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\/([a-zA-Z0-9_-]+)(?:[/?#]|$)/)?.[1];
    if(!id){output.textContent='请在已有 ChatGPT 会话中打开预览。尚无稳定 ID 的新会话不能建立 Session。';return;}
    const result=await chrome.runtime.sendMessage({type:'V2_STATUS',conversationId:id});
    if(!result.ok)throw Error('本地状态读取失败');
    const c=result.conversation;
    output.textContent=JSON.stringify({阶段:'采集层预览，上传未启用',会话:id,
      已采集:c?.messageCount||0,本地待上传:c?.queuedCount||0,来源冲突:c?.conflictCount||0,
      本次响应未支持:c?.unsupportedCount||0,历史曾发现未支持内容:c?.hasUnsupportedHistory||false,
      最后采集:c?new Date(c.lastObservedAt).toLocaleString():'尚未收到自然详情响应',
      范围:c?.lastPage||'未知，不等于完整历史',最近失败:result.lastError,
      最近其他会话:small.v2LastCapture?.id!==id?small.v2LastCapture?.id:undefined},null,2);
  }catch(error){output.textContent=error.message;}
}
document.getElementById('refresh').onclick=refresh;void refresh();
