(function () {
  'use strict';
  let processing=0, since=0, count=0;
  window.addEventListener('message', event=>{
    if (event.source!==window || event.origin!=='https://chatgpt.com') return;
    const d=event.data;
    if (!d || d.type!=='OV_P0_CAPTURE_V1') return;
    const now=Date.now();
    if (now-since>1000) {since=now;count=0;}
    if (++count>12 || processing>=2) return;
    if (typeof d.conversationId!=='string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(d.conversationId)) return;
    if (d.body!==undefined && (typeof d.body!=='string' || d.body.length>2*1024*1024)) return;
    const record={type:'CAPTURE',conversationId:d.conversationId,path:String(d.path||'').slice(0,300),
      query:Array.isArray(d.query)?d.query.slice(0,30):[],requestId:String(d.requestId||'').slice(0,100),
      capturedAt:now,httpStatus:Number(d.httpStatus)||0,bytes:Number(d.bytes)||0,
      error:typeof d.error==='string'?d.error.slice(0,100):null,body:d.body};
    processing++;
    chrome.runtime.sendMessage(record).catch(()=>{}).finally(()=>processing--);
  });
  chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
    if (message?.type!=='P0_DOM_IDS') return;
    const nodes=document.querySelectorAll('[data-message-id]');
    reply({url:location.origin+location.pathname,ids:Array.from(nodes).slice(0,2000)
      .map(n=>n.getAttribute('data-message-id')).filter(Boolean),truncated:nodes.length>2000,
      checkedAt:Date.now()});
  });
})();
