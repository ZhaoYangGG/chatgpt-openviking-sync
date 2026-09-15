(function(root,factory){
 const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.OpenVikingSyncStatus=api;
})(globalThis,function(){
 'use strict';
 const count=n=>Number.isSafeInteger(n)&&n>0?n:0;
 function conversationId(url){
  try{const u=new URL(url);return u.origin==='https://chatgpt.com'?u.pathname.match(/^\/(?:g\/[^/]+\/)?c\/([a-zA-Z0-9_-]+)\/?$/)?.[1]||null:null;}catch{return null;}
 }
 function present(data,id){
  const c=data.conversation||{},total=count(c.messageCount),queued=count(c.queuedCount);
  const isolated=count(c.conflictCount)+count(c.missingTimeCount),confirmed=Math.max(0,total-queued-isolated);
  const page=c.lastPage||{},warnings=[],s=c.captureSummary;
  let history={title:'历史范围尚不确定',detail:'尚无足够的分页信息，不能判断是否已取得最早消息。',action:'想补齐较早历史时，可向上滚动，让 ChatGPT 自己加载；插件不会主动请求历史。'};
  if(page.hasPreviousPage===true)history={title:'本次响应还有更早历史',detail:'最近收到的详情响应报告还有前一页。这不一定表示本地缺少该页。',action:'若还没加载过较早对话，请向上滚动；已采集过的重叠消息会去重。'};
  else if(page.hasNextPage===true)history={title:'本次响应还有后续消息',detail:'最近收到的详情响应报告还有后一页。',action:'请回到较新的消息，让 ChatGPT 加载后续内容。'};
  else if(page.hasPreviousPage===false&&page.hasNextPage===false)history={title:'本次响应未报告更多分页',detail:'无需仅为这个状态反复上滑。但这不是完整历史证明，未支持的内容也不会计入已采集。',action:'目前不需要因分页提示上滑；若刚聊完却没有新采集，可尝试刷新页面补录。'};
  if(s?.unsupported)warnings.push(`本次有 ${s.unsupported} 个暂不支持的内容节点未采集，不能宣称完整备份。`);
  if(s?.nonFinal)warnings.push(`本次有 ${s.nonFinal} 个未满足完成条件的消息节点未采集；这不等同于丢失最终回复。`);
  if(!s&&c.hasUnsupportedHistory)warnings.push('旧记录曾出现未接纳节点，尚未细分原因；再次收到详情后可查看分类，不等同于正文丢失。');
  if(c.conflictCount)warnings.push(`${c.conflictCount} 条来源冲突已隔离，不影响其他消息；不会覆盖远端原文。`);
  if(c.missingTimeCount)warnings.push(`${c.missingTimeCount} 条缺少有效源时间，未上传；不会使用推断时间代替。`);
  if(c.duplicateCount)warnings.push(`远端发现 ${c.duplicateCount} 条重复记录，已标记，不会因此反复补写。`);
  if(c.timeMismatchCount)warnings.push(`${c.timeMismatchCount} 条远端时间与源时间不同；原记录没有被改写。`);
  if(c.policyWarning)warnings.push('消息上传与自动整理是两件事：服务端自动整理配置尚未确认。');
  let key='waiting',title='等待采集详情',detail='还没有取得此会话可同步的消息。',next='可以尝试刷新此页面。插件仅接收 ChatGPT 自然发出的详情响应，不保证每轮实时采集。',tone='neutral',badge='…';
  if(!data.configured){key='unconfigured';title='先连接 OpenViking';detail='尚未配置服务地址，不能上传。';next='打开设置，填写地址与 API Key，并测试连接。';tone='warn';badge='!';}
  else if(!data.enabled){key='paused';title='自动同步已暂停';detail='采集与上传是独立步骤；暂停时不会继续自动上传。';next='在设置中开启自动同步，并确认信任与旧上传器选项。';badge='停';}
  else if(!id){key='no_conversation';title='请打开一个 ChatGPT 会话';detail='当前页面不是带会话 ID 的聊天页面。';next='切换到需要同步的 ChatGPT 会话，再查看这里。';badge='';}
  else if(c.lastError){key='error';title='上传遇到问题';detail='未确认的消息会保留，等待重试；不会影响 ChatGPT 聊天。';next='可点击「重试上传」。若持续失败，请检查连接设置与下方诊断信息。';tone='error';badge='!';}
  else if(data.captureError){key='capture_error';title='最近一次采集异常';detail='采集通道出现异常，当前显示的是已有记录，可能不是最新状态。';next='可以尝试刷新会话重新采集；反复出现时查看诊断信息。';tone='warn';badge='!';}
  else if(c.syncStatus==='syncing'){key='syncing';title='正在上传 / 核验';detail='后台正在与 OpenViking 对账；只有回读确认后才计入已确认。';next='无需操作，可以继续聊天。';tone='busy';badge='↑';}
  else if(queued||c.pendingBatch){key='queued';title='已采集，等待上传';detail=`${queued} 条待确认消息保存在本机；后台会继续处理。`;next='无需上滑来触发上传。也可以点击「重试上传」立即尝试。';tone='busy';badge=queued>99?'99+':String(queued||'…');}
  else if(isolated){key='partial';title='部分消息需要关注';detail=`${confirmed} 条已确认，${isolated} 条已隔离；原因见下方提示。`;next='重复滚动不能修复来源冲突；请先查看提示，再决定是否处理原始数据。';tone='warn';badge='!';}
  else if(total){key='synced';title='已采集内容已同步';detail=`${confirmed} 条已通过远端回读确认。这不代表完整历史或刚生成的回复都已采集。`;next=history.action;tone='success';badge=page.hasPreviousPage===true?'↑':'✓';}
  if(key==='synced'&&warnings.length){tone='warn';badge='!';}
  const filtered=s?count(s.system)+count(s.hidden)+count(s.internal)+count(s.tools)+count(s.thoughts):0;
  return {key,title,detail,next,tone,badge,history,warnings,total,queued,confirmed,isolated,filtered,
   titleText:c.title||'当前会话',canRetry:!!(data.enabled&&id&&key!=='syncing'&&(queued||c.pendingBatch||c.lastError)),canReload:!!id};
 }
 return {conversationId,present};
});
