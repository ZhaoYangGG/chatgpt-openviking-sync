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
  let history={title:'历史范围尚不确定',detail:'当前缺少分页信息，尚不能判断是否已加载最早消息。',action:'如需补录较早历史，请向上滚动，由 ChatGPT 加载相应内容。扩展不会主动请求历史。'};
  if(page.hasPreviousPage===true)history={title:'本页之前还有历史消息',detail:'最近一次响应包含前一页标记，不表示该页一定尚未采集。',action:'若尚未加载较早对话，请向上滚动；已采集的重叠消息会自动去重。'};
  else if(page.hasNextPage===true)history={title:'本页之后还有后续消息',detail:'最近一次响应包含后一页标记，不表示该页一定尚未采集。',action:'若尚未加载较新的消息，请返回相应位置；如果已经加载过，无需重复操作。'};
  else if(page.hasPreviousPage===false&&page.hasNextPage===false)history={title:'本次响应无更多分页',detail:'该分页标记不是完整历史证明；不支持的内容不会计入已采集数量。',action:'目前不需要为补录历史而上滑。若新回复未被采集，可在回复完成后刷新页面。'};
  if(s?.unsupported)warnings.push(`本次有 ${s.unsupported} 个不支持的内容节点未采集，当前记录不包含这些内容。`);
  if(s?.partialText)warnings.push(`本次 ${s.partialText} 条图文提问仅保留文字；图片及其他非文本部分未同步。`);
  else if(c.hasPartialContentHistory)warnings.push('已采集的图文提问中有仅保留文字的消息，图片及其他非文本部分未同步。');
  if(s?.nonFinal)warnings.push(`本次有 ${s.nonFinal} 个未满足完成条件的消息节点未采集；这不等同于丢失最终回复。`);
  if(!s&&c.hasUnsupportedHistory)warnings.push('旧记录曾出现未接纳节点，尚未细分原因；再次收到详情后可查看分类，不等同于正文丢失。');
  if(c.conflictCount)warnings.push(`${c.conflictCount} 条来源冲突已隔离，不影响其他消息；不会覆盖远端原文。`);
  if(c.missingTimeCount)warnings.push(`${c.missingTimeCount} 条缺少有效源时间，未上传；不会使用推断时间代替。`);
  if(c.duplicateCount)warnings.push(`远端发现 ${c.duplicateCount} 条重复记录，已标记，不会因此反复补写。`);
  if(c.timeMismatchCount)warnings.push(`${c.timeMismatchCount} 条远端时间与源时间不同；原记录没有被改写。`);
  if(c.policyWarning)warnings.push('消息上传不等于自动整理完成。服务端自动整理配置尚未确认。');
  let key='waiting',title='等待加载会话数据',detail='尚未收到此会话的有效详情。',next='请在回复完成并保存草稿后刷新页面。扩展随 ChatGPT 加载会话数据时采集，不保证逐轮实时同步。',tone='neutral',badge='…';
  if(!data.configured){key='unconfigured';title='尚未配置 OpenViking';detail='配置服务地址后才能上传消息。';next='打开设置，填写地址与 API Key，并测试连接。';tone='warn';badge='!';}
  else if(!data.enabled){key='paused';title='自动同步已暂停';detail='暂停期间不会自动上传；页面加载的消息仍可能保存在本机。';next='如需恢复上传，请在设置中开启自动同步，并完成数据来源与旧版同步工具确认。';badge='停';}
  else if(!id){key='no_conversation';title='请打开一个 ChatGPT 会话';detail='当前页面不是带会话 ID 的聊天页面。';next='切换到需要同步的 ChatGPT 会话，再查看这里。';badge='';}
  else if(c.lastError){key='error';title='上传遇到问题';detail='未确认的消息会保留，等待重试；不会影响 ChatGPT 聊天。';next='可点击「重试上传」。若持续失败，请检查连接设置与下方诊断信息。';tone='error';badge='!';}
  else if(data.captureError){key='capture_error';title='最近一次采集异常';detail='采集通道出现异常，当前显示的是已有记录，可能不是最新状态。';next='可以尝试刷新会话重新采集；反复出现时查看诊断信息。';tone='warn';badge='!';}
  else if(c.syncStatus==='syncing'){key='syncing';title='正在同步并核验';detail='正在核对 OpenViking 中的记录。完成回读验证后，消息才计入远端已确认。';next='无需操作，可以继续聊天。';tone='busy';badge='↑';}
  else if(queued||c.pendingBatch){key='queued';title='已采集，等待上传';detail=`${queued} 条待确认消息保存在本机；后台会继续处理。`;next='无需上滑来触发上传。也可以点击「重试上传」立即尝试。';tone='busy';badge=queued>99?'99+':String(queued||'…');}
  else if(isolated){key='partial';title='部分消息需要关注';detail=`${confirmed} 条已确认，${isolated} 条已隔离；原因见下方提示。`;next='重复滚动不能修复来源冲突；请先查看提示，再决定是否处理原始数据。';tone='warn';badge='!';}
  else if(total){key='synced';title='已采集内容已同步';detail=`${confirmed} 条已通过远端回读确认。这不代表完整历史或刚生成的回复都已采集。`;next=history.action;tone='success';badge=page.hasPreviousPage===true?'↑':'✓';}
  else if(c.lastObservedAt!=null){key='no_eligible';title='已收到详情，暂无可同步消息';detail=`本次已检查 ${count(c.lastNodeCount)} 个消息节点，未发现支持的用户文字或已完成的最终文字回复。`;next='请查看下方内容说明。图片和工具输出不在文字同步范围内；正在生成的回复需要在完成后重新加载。';tone='warn';badge='!';}
  if(key==='synced'&&warnings.length){tone='warn';badge='!';}
  if(key==='capture_error'&&data.captureError.error==='pagination_context_missing'){
   title='历史分页缺少会话验证';detail='收到了历史分页，但此页面尚无同一配置下已验证的会话详情，出于隐私保护未入库。';
   next='请先保存草稿并等待回复完成，再刷新会话取得详情，然后重新上滑加载历史。';
  }
  const filtered=s?count(s.system)+count(s.hidden)+count(s.internal)+count(s.tools)+count(s.thoughts):0;
  return {key,title,detail,next,tone,badge,history,warnings,total,queued,confirmed,isolated,filtered,
   titleText:c.title||'当前会话',canRetry:!!(data.enabled&&id&&key!=='syncing'&&(queued||c.pendingBatch||c.lastError)),canReload:!!id};
 }
 return {conversationId,present};
});
