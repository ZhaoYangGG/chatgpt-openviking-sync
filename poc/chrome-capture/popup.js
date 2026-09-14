'use strict';
let report={records:[]};
const $=id=>document.getElementById(id);
const format=t=>new Date(t).toLocaleString();
async function refresh() {
  const data=await chrome.runtime.sendMessage({type:'REPORT'});
  if (!data.ok) throw new Error('无法读取本地诊断');
  report=data;
  $('records').replaceChildren();
  for(const record of [...data.records].reverse()) {
    const article=document.createElement('article'),title=document.createElement('h2'),detail=document.createElement('pre');
    title.textContent=record.checkpoint ? `检查点：${record.checkpoint}` : record.result?.title || record.conversationId;
    detail.textContent=record.checkpoint ? format(record.receivedAt) : JSON.stringify({
      time:format(record.receivedAt),path:record.path,query:record.query,
      error:record.error,privacy:record.result?.excluded ? record.result.reason:undefined,
      nodes:record.result?.nodeCount,acceptedMessages:record.result?.messages.length,
      counts:record.result?.counts,page:record.result?.pageInfo,
      unsupported:record.result?.omissions,scope:'本次响应范围；未验证完整历史'},null,2);
    if(record.error)article.className='error';article.append(title,detail);$('records').append(article);
  }
  $('status').textContent=`本地 ${data.records.length} 个事件。没有新详情响应时不会补录。`;
}
async function compare() {
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id || !tab.url?.startsWith('https://chatgpt.com/'))throw new Error('请在 ChatGPT 标签页中打开插件');
  const dom=await chrome.tabs.sendMessage(tab.id,{type:'P0_DOM_IDS'});
  const conv=dom.url.match(/\/c\/([a-zA-Z0-9_-]+)/)?.[1];
  const captures=report.records.filter(r=>r.tabId===tab.id && r.conversationId===conv && r.result && !r.result.excluded);
  if(!captures.length)throw new Error('当前会话尚无可核对的详情响应；先刷新后重试');
  // Compare all retained pages, not just the latest page. DOM absence is not an ID mismatch.
  const ids=captures.flatMap(r=>r.result.messages.map(m=>m.id));
  const result={checkedAt:dom.checkedAt,conversationId:conv,domTruncated:dom.truncated,
    ...P0Parser.compareDom(ids,dom.ids)};
  report.domComparison=result;$('comparison').textContent=JSON.stringify(result,null,2);
}
function exportReport() {
  const safe=structuredClone(report);
  for(const record of safe.records) for(const message of record.result?.messages||[]) {delete message.content;delete message.parts;}
  const blob=new Blob([JSON.stringify({...safe,exportedAt:new Date().toISOString(),source:'Chrome P0 passive capture'},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='openviking-p0-report.json';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const action=fn=>()=>Promise.resolve().then(fn).catch(e=>{$('status').textContent=e.message;});
$('refresh').onclick=action(refresh);$('compare').onclick=action(compare);$('export').onclick=action(exportReport);
$('checkpoint').onclick=action(async()=>{await chrome.runtime.sendMessage({type:'CHECKPOINT',label:$('label').value});await refresh();});
void action(refresh)();
