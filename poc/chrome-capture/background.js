importScripts('parser.js');
'use strict';
const DB_NAME='openviking-p0-readonly-v1';
const MAX_RECORDS=40, MAX_BYTES=4*1024*1024;
let queue=Promise.resolve();
let pendingCaptures=0;
const pendingRequest=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
async function database() {
  const req=indexedDB.open(DB_NAME,1);
  req.onupgradeneeded=()=>req.result.createObjectStore('captures',{keyPath:'recordId',autoIncrement:true});
  return pendingRequest(req);
}
async function records() {
  const db=await database();
  try {return await pendingRequest(db.transaction('captures').objectStore('captures').getAll());}
  finally {db.close();}
}
async function append(record) {
  // This P0 is a bounded diagnostic ring, not the production unsynced outbox.
  const bytes=new TextEncoder().encode(JSON.stringify(record)).byteLength;
  if (bytes>MAX_BYTES) throw new Error('report_too_large');
  const db=await database();
  try {
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('captures','readwrite'),s=tx.objectStore('captures');
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error || new Error('db_aborted'));tx.onerror=()=>{};
      const req=s.getAll();
      req.onsuccess=()=>{
        const old=req.result;
        let total=old.reduce((n,r)=>n+(r.storedBytes||0),0)+bytes;
        while(old.length>=MAX_RECORDS || total>MAX_BYTES) {const r=old.shift();if(!r)break;total-=r.storedBytes||0;s.delete(r.recordId);}
        s.add({...record,storedBytes:bytes});
      };
    });
  } finally {db.close();}
}
function safeQuery(query) {
  return (Array.isArray(query)?query:[]).slice(0,30).map(q=>({key:String(q?.key||'').slice(0,100),
    value:/^(num_turns|include_has_versions|cursor|before|after|start_cursor|end_cursor)$/.test(q?.key)
      && /^[a-zA-Z0-9_.:-]{0,200}$/.test(q?.value) ? q.value:'[redacted]'}));
}
async function capture(d,sender) {
  if (!sender.tab || sender.frameId!==0 || new URL(sender.url).origin!=='https://chatgpt.com') throw new Error('invalid_sender');
  if (!P0Parser.isId(d.conversationId) || typeof d.body!=='string' && !d.error
      || typeof d.body==='string' && new TextEncoder().encode(d.body).length>2*1024*1024) throw new Error('invalid_payload');
  const record={tabId:sender.tab.id,receivedAt:Date.now(),conversationId:d.conversationId,
    path:String(d.path||'').slice(0,300),query:safeQuery(d.query),httpStatus:Number(d.httpStatus)||0,
    requestId:String(d.requestId||'').slice(0,100),bytes:Number(d.bytes)||0};
  if (d.error) record.error=['not_successful_json','capture_limit','capture_failed_or_limit'].includes(d.error)
    ? d.error : 'capture_failed_or_not_json';
  else {
    try {record.result=P0Parser.parseDetail(JSON.parse(d.body),d.conversationId);}
    catch (e) {record.error=['conversation_id_mismatch','unsupported_schema','invalid_message','invalid_or_duplicate_id'].includes(e.message)?e.message:'invalid_json_or_schema';}
  }
  // Raw HTTP payload, hidden/internal content and credentials are never stored.
  await append(record);
  return {ok:true};
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  let operation;
  if (message?.type==='CAPTURE') {
    if (pendingCaptures>=8) {reply({ok:false,error:'capture_backlog_limit'});return false;}
    pendingCaptures++;
    operation=()=>capture(message,sender).finally(()=>pendingCaptures--);
  } else if (sender.id===chrome.runtime.id && sender.url===chrome.runtime.getURL('popup.html')) {
    if (message?.type==='REPORT') operation=async()=>({ok:true,records:await records(),limits:{records:MAX_RECORDS,bytes:MAX_BYTES}});
    if (message?.type==='CHECKPOINT') operation=async()=>{
      const allowed=['before_reply','after_reply','returned_to_chat','reopened_tab','after_reload','after_scroll'];
      if (!allowed.includes(message.label)) throw new Error('unknown_checkpoint');
      await append({receivedAt:Date.now(),checkpoint:message.label});return {ok:true};
    };
  }
  if (!operation) return false;
  const work=queue.then(operation);queue=work.catch(()=>{});
  work.then(reply,()=>reply({ok:false,error:'capture_or_storage_failed'}));
  return true;
});
