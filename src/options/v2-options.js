'use strict';
const $=id=>document.getElementById(id),send=m=>chrome.runtime.sendMessage(m);
const fields=['server-url','api-key','agent-id','auth-mode','namespace'];
async function load(){
 const r=await send({type:'V2_GET_CONFIG'});if(!r.ok)throw Error(r.error);
 const c=r.config;
 for(const [id,key] of [['server-url','serverUrl'],['api-key','apiKey'],['agent-id','agentId'],['auth-mode','authMode'],['namespace','namespace']])$(id).value=c[key];
 $('enabled').checked=c.enabled;$('legacy-stopped').checked=c.legacyStopped;$('source-trust').checked=c.sourceTrustAccepted;
 $('auto-commit-enabled').checked=c.autoCommitEnabled;
 for(const [id,key] of [['message-threshold','message_count_threshold'],['idle-timeout','idle_timeout_seconds'],['token-threshold','pending_token_threshold'],['keep-recent','keep_recent_count']])$(id).value=c.autoCommitPolicy[key];
}
function show(text,ok){$('result').hidden=false;$('result').className='result '+(ok?'success':'error');$('result').textContent=text;}
$('settings-form').addEventListener('submit',async event=>{
 event.preventDefault();$('save-button').disabled=true;
 try{
  const config={serverUrl:$('server-url').value.trim(),apiKey:$('api-key').value.trim(),agentId:$('agent-id').value.trim(),
   authMode:$('auth-mode').value,namespace:$('namespace').value.trim(),enabled:$('enabled').checked,
   sourceTrustAccepted:$('source-trust').checked,legacyStopped:$('legacy-stopped').checked,
   autoCommitEnabled:$('auto-commit-enabled').checked,autoCommitPolicy:{
    pending_token_threshold:$('token-threshold').value,message_count_threshold:$('message-threshold').value,
    idle_timeout_seconds:$('idle-timeout').value,keep_recent_count:$('keep-recent').value,min_commit_interval_seconds:60}};
  const u=new URL(config.serverUrl);if(u.username||u.password)throw Error('服务地址不能包含凭据');
  if(!await chrome.permissions.request({origins:[u.origin+'/*']}))throw Error('未授权服务域名');
  const saved=await send({type:'V2_SAVE_CONFIG',config});if(!saved.ok)throw Error(saved.error);
  const tested=await send({type:'V2_TEST_CONNECTION'});
  show(tested.ok?'设置已保存，连接成功。请刷新目标 ChatGPT 会话。':'设置已保存，但连接失败：'+tested.error,tested.ok);
 }catch(e){show(e.message,false);}finally{$('save-button').disabled=false;}
});
void load().catch(e=>show(e.message,false));
