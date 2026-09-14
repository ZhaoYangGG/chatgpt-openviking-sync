(function(){
 'use strict';
 let pending=0,init=false,windowAt=0,count=0,reported=false;
 async function initialize(){
  if(init)return;init=true;
  try{await chrome.runtime.sendMessage({type:'V2_INIT'});}catch{}
 }
 window.addEventListener('message',event=>{
  if(event.source!==window||event.origin!=='https://chatgpt.com')return;
  const d=event.data;if(d?.type!=='OV_V2_SIGNED')return;
  const now=Date.now();if(now-windowAt>1000){windowAt=now;count=0;reported=false;}
  if(++count>13||pending>=2||typeof d.text!=='string'||d.text.length>2097500){
   if(!reported){reported=true;chrome.runtime.sendMessage({type:'V2_RELAY_ERROR'}).catch(()=>{});}return;
  }
  pending++;
  chrome.runtime.sendMessage({type:'V2_SIGNED_CAPTURE',channel:d.channel,seq:d.seq,text:d.text,mac:d.mac})
    .catch(()=>{}).finally(()=>pending--);
 });
 // No DOM/body polling. Pages restored by BFCache keep the same document/channel.
 window.addEventListener('pageshow',()=>{void initialize();});
 void initialize();
})();
