'use strict';
importScripts('../shared/core.js','../capture/parser.js','message-store.js');
const store=new OpenVikingMessageStore.MessageStore();
const SCOPE='preview-local-only'; // Must bind destination/account before P1-b enables uploads.
let queued=0;
const errors=new Set(['not_successful_json','capture_limit','capture_failed_or_limit','capture_backlog_limit','storage_capacity_reached']);
async function setError(error){
  await chrome.storage.local.set({v2CaptureError:{error:errors.has(error)?error:'capture_or_storage_failed',at:Date.now()}});
  await chrome.action.setBadgeText({text:'!'});
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type==='V2_STATUS'&&sender.url===chrome.runtime.getURL('src/popup/v2-popup.html')){
    Promise.all([store.getConversation(SCOPE,message.conversationId),chrome.storage.local.get('v2CaptureError')])
      .then(([conversation,small])=>reply({ok:true,conversation:conversation||null,lastError:small.v2CaptureError||null,uploadEnabled:false}),()=>reply({ok:false}));
    return true;
  }
  let valid=false;try{valid=sender.frameId===0&&!!sender.tab&&new URL(sender.url).origin==='https://chatgpt.com';}catch{}
  if(!valid||!['V2_CAPTURE','V2_CAPTURE_ERROR'].includes(message?.type))return false;
  if(queued>=4){void setError('capture_backlog_limit').catch(()=>{});reply({ok:false});return false;}
  queued++;
  (async()=>{
    try{
      if(message.error){await setError(message.error);reply({ok:false});return;}
      if(typeof message.body!=='string'||new TextEncoder().encode(message.body).length>2*1024*1024)throw Error('capture_limit');
      const detail=OpenVikingDetailParser.parseDetail(JSON.parse(message.body),message.conversationId);
      const result=await store.ingest(SCOPE,detail);
      // Persist only a small status record outside IDB; never the message collection.
      if(!detail.excluded)await chrome.storage.local.set({v2LastCapture:{id:detail.conversationId,at:Date.now()}});
      reply({ok:true,...result});
    }catch(error){await setError(error.message).catch(()=>{});reply({ok:false});}
    finally{queued--;}
  })();
  return true;
});
