'use strict';
// P0 pure decision model. No network, persistence, or production uploader wiring.
// Input remoteRecords comes from V1 readSessionMessages (live + archives).
const {normalizeMessageContent}=require('../src/shared/core.js');
const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(v);
function reconcileSnapshot({conversationId,candidates,remoteRecords,reportedTotal}) {
  if(!validId(conversationId)||!Array.isArray(candidates)||!Array.isArray(remoteRecords))throw Error('invalid_snapshot');
  // A mismatched physical watermark means the read may be racing with a writer/commit.
  // Retry a fresh read; never interpret a partial log as permission to resend.
  if(!Number.isSafeInteger(reportedTotal)||reportedTotal<0||reportedTotal!==remoteRecords.length)
    return {status:'needs_fresh_read',toSend:[],confirmed:[],conflicts:[],duplicates:[]};
  const prefix=`chatgpt:${conversationId}:`;
  function key(row) {
    const id=row.sourceMessageId;
    if(typeof id!=='string')return null;
    const suffix=id.startsWith(prefix)?id.slice(prefix.length):id;
    return validId(suffix)?prefix+suffix:null;
  }
  const signature=row=>JSON.stringify([row.role,normalizeMessageContent(row.content)]);
  const remote=new Map(),local=new Map();let foreignRecords=0;
  for(const row of remoteRecords) {
    const id=key(row);if(!id){foreignRecords++;continue;}
    if(!remote.has(id))remote.set(id,[]);remote.get(id).push(row);
  }
  for(const row of candidates) {
    const id=key(row);
    if(!id||!['user','assistant'].includes(row.role)||typeof row.content!=='string')throw Error('invalid_candidate');
    if(!local.has(id))local.set(id,[]);local.get(id).push(row);
  }
  const duplicates=[],conflictSet=new Set(),confirmed=[],toSend=[];
  for(const [id,rows] of remote) {
    const variants=new Set(rows.map(signature));
    if(variants.size>1)conflictSet.add(id);
    else if(rows.length>1)duplicates.push({sourceMessageId:id,physicalCount:rows.length});
  }
  // Map insertion order preserves observed page order, never timestamp order.
  for(const [id,rows] of local) {
    const variants=new Set(rows.map(signature)),existing=remote.get(id);
    if(variants.size!==1||existing?.some(row=>signature(row)!==signature(rows[0])))conflictSet.add(id);
    if(conflictSet.has(id))continue;
    if(existing)confirmed.push(id);else toSend.push(rows[0]);
  }
  return {status:'best_effort',physicalCount:remoteRecords.length,uniqueRemoteSources:remote.size,
    foreignRecords,duplicates,conflicts:[...conflictSet],confirmed,toSend};
}
module.exports={reconcileSnapshot};
