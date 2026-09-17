(function(){
 'use strict';
 let pending=0,init=false,windowAt=0,count=0,reported=false;
 // Reloading/upgrading an extension invalidates contexts in already-open tabs.
 // sendMessage can throw synchronously, before it returns a Promise.
 async function send(message){try{return await chrome.runtime.sendMessage(message);}catch{return null;}}
 async function initialize(){
  if(init)return;init=true;
  await send({type:'V2_INIT'});
 }
 window.addEventListener('message',event=>{
  if(event.source!==window||event.origin!=='https://chatgpt.com')return;
  const d=event.data;if(d?.type!=='OV_V2_SIGNED')return;
  const now=Date.now();if(now-windowAt>1000){windowAt=now;count=0;reported=false;}
  if(++count>13||pending>=2||typeof d.text!=='string'||d.text.length>2097500){
   if(!reported){reported=true;void send({type:'V2_RELAY_ERROR'});}return;
  }
  pending++;
  void send({type:'V2_SIGNED_CAPTURE',channel:d.channel,seq:d.seq,text:d.text,mac:d.mac})
    .finally(()=>pending--);
 });
 // No DOM/body polling. Pages restored by BFCache keep the same document/channel.
 window.addEventListener('pageshow',()=>{void initialize();});
 void initialize();
})();
