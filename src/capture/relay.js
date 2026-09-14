(function(){
  'use strict';
  let pending=0,windowStart=0,count=0,overloadReported=false;
  function signal(error){
    if(overloadReported)return;overloadReported=true;
    chrome.runtime.sendMessage({type:'V2_CAPTURE_ERROR',error}).catch(()=>{});
  }
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!=='https://chatgpt.com')return;
    const d=event.data;if(d?.type!=='OV_V2_CAPTURE_V1')return;
    const now=Date.now();if(now-windowStart>1000){windowStart=now;count=0;overloadReported=false;}
    if(++count>12||pending>=2){signal('capture_backlog_limit');return;}
    if(typeof d.conversationId!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(d.conversationId))return;
    if(d.body!==undefined&&(typeof d.body!=='string'||d.body.length>2*1024*1024)){signal('capture_limit');return;}
    pending++;
    chrome.runtime.sendMessage({type:'V2_CAPTURE',conversationId:d.conversationId,body:d.body,
      error:typeof d.error==='string'?d.error.slice(0,80):null}).catch(()=>{}).finally(()=>pending--);
  });
})();
