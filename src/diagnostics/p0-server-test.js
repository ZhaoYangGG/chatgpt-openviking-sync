'use strict';
const output=document.getElementById('output'),runButton=document.getElementById('run');
let client,report={startedAt:null,steps:[],sessionsCreated:[],status:'not_started'};
const log=(step,data)=>{report.steps.push({at:new Date().toISOString(),step,...data});output.textContent=JSON.stringify(report,null,2);};
const safeFetch=(url,options)=>fetch(url,{...options,redirect:'error'});
async function loadClient() {
  const stored=await chrome.storage.local.get(OpenVikingSyncCore.CONFIG_KEY);
  const config=OpenVikingSyncCore.normalizeConfig(stored[OpenVikingSyncCore.CONFIG_KEY]);
  if (!config.serverUrl) throw new Error('not_configured');
  client=new OpenVikingClientModule.OpenVikingClient(config,{fetch:safeFetch,timeoutMs:15000});
  return config;
}
function fail(error) {
  report.status='blocked_or_failed';
  log('stopped',{httpStatus:error.httpStatus||0,code:error.code||'LOCAL_VALIDATION_FAILED',
    reason:['safety_not_confirmed','session_not_empty','no_log_visibility','test_session_collision'].includes(error.message)?error.message:'inspect_status_and_api_contract'});
  document.getElementById('export').disabled=false;
}
document.getElementById('inspect').onclick=async()=>{
  try {
    const config=await loadClient(),health=await client.testConnection();
    report.serverUrl=config.serverUrl;report.healthVersion=typeof health?.version==='string'?health.version:null;
    log('connection',{ok:true,version:report.healthVersion});runButton.disabled=false;
  } catch(error){fail(error);}
};
runButton.onclick=async()=>{
  runButton.disabled=true;document.getElementById('inspect').disabled=true;
  report.startedAt=new Date().toISOString();report.status='running';
  const sessionId=`ov_p0_${Date.now()}_${crypto.randomUUID().slice(0,8)}`;
  const conversationId=sessionId;
  // Independent client objects share only server identity, not a client lock/index.
  let other;
  const message=(id,content=`P0 synthetic diagnostic ${id}; not a user preference.`)=>({
    role:'user',content,sourceMessageId:id,createdAt:'2026-09-11T00:00:00.000Z',turnId:`p0:${id}`});
  const takeSnapshot=async(name)=>{
    const meta=await client.getSession(sessionId);
    if (!Object.hasOwn(meta,'auto_commit_policy') || meta.auto_commit_policy!==null) throw new Error('safety_not_confirmed');
    const records=await client.readSessionMessages(sessionId,conversationId,meta);
    const groups={};
    for(const row of records){const key=row.sourceMessageId||'[missing_source_id]';(groups[key]??=[]).push(row.content);}
    const snapshot={reportedTotal:meta.total_message_count??null,physicalRecords:records.length,
      sources:Object.fromEntries(Object.entries(groups).map(([id,contents])=>[id,{count:contents.length,distinctContents:new Set(contents).size}])),
      sourceOrder:records.map(r=>r.sourceMessageId)};
    if (Number.isInteger(snapshot.reportedTotal) && snapshot.reportedTotal!==records.length) throw new Error('no_log_visibility');
    log(name,snapshot);return snapshot;
  };
  try {
    const config=await loadClient();
    other=new OpenVikingClientModule.OpenVikingClient(config,{fetch:safeFetch,timeoutMs:15000});
    try {await client.getSession(sessionId);throw new Error('test_session_collision');}
    catch(error){if(error.httpStatus!==404)throw error;}
    // Record intent before POST so an ambiguous response still leaves an exact target.
    report.sessionCreationIntent=sessionId;log('creating_test_session',{sessionId});
    await client.request('/api/v1/sessions',{method:'POST',body:{session_id:sessionId,
      auto_commit_policy:null,memory_policy:{self:{enabled:false},peer:{enabled:false},working_memory:{enabled:false}}}});
    report.sessionsCreated.push(sessionId);
    const policy=await client.request(`/api/v1/sessions/${sessionId}/config`,{method:'PATCH',body:{auto_commit_policy:null}});
    if (!Object.hasOwn(policy,'auto_commit_policy') || policy.auto_commit_policy!==null) throw new Error('safety_not_confirmed');
    const initial=await takeSnapshot('isolation_confirmed');
    if(initial.physicalRecords!==0)throw new Error('session_not_empty');
    await client.addMessages(sessionId,conversationId,[message('repeat')]);
    await takeSnapshot('sequential_first');
    await other.addMessages(sessionId,conversationId,[message('repeat')]);
    await takeSnapshot('sequential_repeat');
    for(let i=0;i<3;i++) {
      const results=await Promise.allSettled([client,other].map(c=>c.addMessages(sessionId,conversationId,[message(`parallel_${i}`)])));
      log(`parallel_${i}_http`,{outcomes:results.map(r=>r.status==='fulfilled'?'fulfilled':`error_${r.reason?.httpStatus||0}`)});
      await takeSnapshot(`parallel_${i}_readback`);
    }
    const overlap=await Promise.allSettled([
      client.addMessages(sessionId,conversationId,[message('overlap_a'),message('overlap_b')]),
      other.addMessages(sessionId,conversationId,[message('overlap_b'),message('overlap_c')])]);
    log('overlap_http',{outcomes:overlap.map(r=>r.status==='fulfilled'?'fulfilled':`error_${r.reason?.httpStatus||0}`)});
    await takeSnapshot('overlap_readback');
    // Simulate losing a local acknowledgement: don't reuse an in-memory confirmed index.
    await client.addMessages(sessionId,conversationId,[message('lost_ack')]);
    const recovered=await takeSnapshot('lost_ack_recovery_read');
    log('lost_ack_recovery_decision',{skipRetry:!!recovered.sources.lost_ack});
    await client.addMessages(sessionId,conversationId,[message('changed','P0 synthetic revision one.')]);
    try {await other.addMessages(sessionId,conversationId,[message('changed','P0 synthetic revision two.')]);log('changed_id_http',{accepted:true});}
    catch(error){log('changed_id_http',{accepted:false,httpStatus:error.httpStatus||0});}
    const final=await takeSnapshot('final');
    report.status='completed_available_tests';
    report.observedDuplicateIds=Object.entries(final.sources).filter(([,v])=>v.count>1).map(([id])=>id);
    report.modeEvidence=report.observedDuplicateIds.length?'append_behavior_observed_best_effort_required':'no_duplicates_in_this_test_not_a_contract';
    report.notTested=['archive_after_commit','real_two_device_profiles','best_effort_production_state_machine'];
    log('completed',{autoCommit:false,manualCommit:false,deleted:false});
  } catch(error){fail(error);}
  finally {document.getElementById('export').disabled=false;}
};
document.getElementById('export').onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='openviking-p0-server-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
