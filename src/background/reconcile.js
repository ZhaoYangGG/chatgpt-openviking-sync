(function(root,factory){
  const core=root.OpenVikingSyncCore||(typeof require==='function'?require('../shared/core'):null);
  const api=factory(core);if(typeof module==='object'&&module.exports)module.exports=api;root.OpenVikingReconcile=api;
})(globalThis,function(core){
  function reconcile({conversationId,candidates,records,total}){
    if(!Number.isSafeInteger(total)||total!==records.length)throw Error('snapshot_unstable');
    const prefix='chatgpt:'+conversationId+':',remote=new Map(),duplicates=[],conflicts=[],confirmed=[],toSend=[];
    let timeMismatchCount=0;
    let foreign=0;
    const key=id=>typeof id==='string'&&id.startsWith(prefix)?id:typeof id==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(id)?prefix+id:null;
    // V1 stored normalized text. Compare the same representation without rewriting local originals.
    const sig=r=>JSON.stringify([r.role,core.normalizeMessageContent(r.content)]);
    for(const r of records){const id=key(r.sourceMessageId);if(!id){foreign++;continue;}if(!remote.has(id))remote.set(id,[]);remote.get(id).push(r);}
    for(const [id,rows] of remote)if(rows.length>1)duplicates.push({id,count:rows.length});
    for(const c of candidates){
      const rows=remote.get(c.sourceMessageId);
      if(rows?.some(r=>sig(r)!==sig(c))){conflicts.push(c);continue;}
      if(rows){
        confirmed.push(c);
        const canonical=t=>Number.isFinite(Date.parse(t))?Math.floor(Date.parse(t)/1000)+':'+(/\.(\d+)/.exec(t)?.[1]||'').replace(/0+$/,''):null;
        if(c.createdAt&&rows.some(r=>canonical(r.createdAt)!==canonical(c.createdAt)))timeMismatchCount++;
      }else toSend.push(c);
    }
    return {confirmed,conflicts,toSend,duplicates,foreign,timeMismatchCount,physicalCount:total,uniqueCount:remote.size};
  }
  return {reconcile};
});
