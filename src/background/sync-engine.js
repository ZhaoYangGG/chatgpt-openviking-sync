(function(root,factory){
 const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.OpenVikingSyncEngine=api;
})(globalThis,function(){
 'use strict';
 class SyncEngine{
  constructor({store,client,reconcile,toIso,isEnabled=async()=>true,now=()=>Date.now()}){Object.assign(this,{store,client,reconcile,toIso,isEnabled,now});}
  async snapshot(sessionId,id){
    const before=await this.client.getSession(sessionId);
    const records=await this.client.readSessionMessages(sessionId,id,before);
    const after=await this.client.getSession(sessionId);
    const total=after.total_message_count;
    if(Number.isSafeInteger(total)){
      if(total!==before.total_message_count||total!==records.length)throw Error('snapshot_unstable');
    }else if(before.total_message_count!=null||total!=null)throw Error('snapshot_unstable');
    return {records,total:total??records.length};
  }
  candidate(row){
    return {id:row.key[2],sourceMessageId:row.metadata.sourceMessageId,role:row.metadata.role,
      content:row.content,contentHash:row.contentHash,createdAt:this.toIso(row.metadata.createTimeDecimal),
      turnId:row.metadata.turnId||undefined};
  }
  async run(scope,id,config,{force=false,sessionIdOverride}={}){
    let c=await this.store.getConversation(scope,id);if(!c||(!force&&c.nextRetryAt>this.now())||!await this.isEnabled())return;
    const sessionId=c.sessionId||sessionIdOverride;
    const resolve=(rows,status)=>rows.map(r=>({id:r.id,contentHash:r.contentHash,status}));
    try{
      const pending=c.pendingBatch;
      let queue=await this.store.listOutbox(scope,id,100);
      if(!queue.length&&!pending){
        if(c.migratedBySourceReadback&&config.revision&&c.policyRevision!==config.revision){
          const actual=await this.client.updateSessionConfig(sessionId,config.autoCommitEnabled?config.autoCommitPolicy:null);
          const matches=config.autoCommitEnabled?Object.entries(config.autoCommitPolicy).every(([k,v])=>actual.auto_commit_policy?.[k]===v):actual.auto_commit_policy===null;
          await this.store.updateSync(scope,id,{policyWarning:matches?null:'policy_not_confirmed',policyRevision:config.revision});
        }
        return;
      }
      await this.store.updateSync(scope,id,{syncStatus:'syncing',lastError:null});
      // An uncertain write must never be "recovered" into a newly recreated Session.
      let session=pending?await this.client.getSession(sessionId):await this.client.ensureSession(sessionId);
      let policyWarning=null;
      try{
        const policy=config.autoCommitEnabled?config.autoCommitPolicy:null;
        const matches=p=>policy===null?p===null:Object.entries(policy).every(([k,v])=>p?.[k]===v);
        if(!matches(session.auto_commit_policy)){
          const actual=await this.client.updateSessionConfig(sessionId,policy);
          if(!matches(actual.auto_commit_policy))policyWarning='policy_not_confirmed';
        }
      }catch{policyWarning='policy_update_failed';}
      const keys=[...new Set([...queue.map(r=>r.key[2]),...(pending?.ids||[])])];
      const rows=(await this.store.getRows(scope,id,keys)).filter(Boolean);
      const candidates=[],missing=[];
      for(const row of rows){
        if(row.status==='conflict')continue;
        try{candidates.push(this.candidate(row));}catch{missing.push({id:row.key[2],contentHash:row.contentHash});}
      }
      if(missing.length)await this.store.updateSync(scope,id,{},resolve(missing,'missing_time'));
      const snap=await this.snapshot(sessionId,id);
      let decision=this.reconcile({conversationId:id,candidates,...snap});
      // Foreign log entries do not belong to this Conversation. Fail closed on identity migration.
      if(decision.foreign)throw Error('session_identity_conflict');
      await this.store.updateSync(scope,id,{pendingBatch:null,policyWarning,policyRevision:config.revision||null,
        remotePhysicalCount:decision.physicalCount,remoteUniqueCount:decision.uniqueCount,
        duplicateCount:decision.duplicates.reduce((n,d)=>n+d.count-1,0),
        timeMismatchCount:Math.max(c.timeMismatchCount||0,decision.timeMismatchCount),
        migratedBySourceReadback:true,lastReconciledAt:this.now()},
        [...resolve(decision.confirmed,'synced'),...resolve(decision.conflicts,'conflict')]);
      // Never mutate an established remote message just to "fix" a V1 inferred timestamp.
      let batch=decision.toSend.slice(0,100);
      c=await this.store.getConversation(scope,id);
      if(batch.length){
        if(!await this.isEnabled())return;
        // Recheck local revisions before persisting intent and sending.
        const latest=await this.store.getRows(scope,id,batch.map(r=>r.id));
        batch=batch.filter((r,i)=>latest[i]?.status==='queued'&&latest[i].contentHash===r.contentHash);
        if(batch.length){
          await this.store.updateSync(scope,id,{pendingBatch:{ids:batch.map(r=>r.id),createdAt:this.now()}});
          if(!await this.isEnabled())return;
          // V1 client adds chatgpt:<conversation>: itself; pass only the raw message ID.
          await this.client.addMessages(sessionId,id,batch.map(item=>({...item,sourceMessageId:item.id})));
          const post=await this.snapshot(sessionId,id);
          decision=this.reconcile({conversationId:id,candidates:batch,...post});
          if(decision.foreign)throw Error('session_identity_conflict');
          await this.store.updateSync(scope,id,{
            remotePhysicalCount:decision.physicalCount,remoteUniqueCount:decision.uniqueCount,
            duplicateCount:decision.duplicates.reduce((n,d)=>n+d.count-1,0),
            timeMismatchCount:Math.max(c.timeMismatchCount||0,decision.timeMismatchCount)},
            [...resolve(decision.confirmed,'synced'),...resolve(decision.conflicts,'conflict')]);
          if(decision.toSend.length)throw Error('write_not_confirmed');
          await this.store.updateSync(scope,id,{pendingBatch:null});
        }
      }
      c=await this.store.getConversation(scope,id);
      await this.store.updateSync(scope,id,{syncStatus:c.queuedCount?'queued':'synced',lastError:null,
        attempts:0,nextRetryAt:0,lastSyncedAt:this.now()});
    }catch(error){
      c=await this.store.getConversation(scope,id);
      const attempts=(c.attempts||0)+1,delay=Math.min(3600000,15000*2**Math.min(attempts-1,8));
      const known=['snapshot_unstable','session_identity_conflict','write_not_confirmed','storage_capacity_reached'];
      const code=known.includes(error.message)?error.message:error.httpStatus?'HTTP_'+error.httpStatus:'service_unavailable';
      await this.store.updateSync(scope,id,{syncStatus:'error',lastError:code,attempts,nextRetryAt:this.now()+delay});
    }
  }
 }
 return {SyncEngine};
});
