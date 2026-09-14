(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.OpenVikingCaptureAuth=api;})(globalThis,function(){
 async function verify(envelope,entry,crypto=globalThis.crypto){
  if(!entry||envelope.channel!==entry.channel||!Number.isSafeInteger(envelope.seq)||envelope.seq<=entry.lastSeq
   ||typeof envelope.text!=='string'||new TextEncoder().encode(envelope.text).length>2097500
   ||typeof envelope.mac!=='string'||!/^[0-9a-f]{64}$/.test(envelope.mac))return false;
  const key=await crypto.subtle.importKey('raw',new Uint8Array(entry.secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes=new Uint8Array(envelope.mac.match(/../g).map(x=>parseInt(x,16)));
  return crypto.subtle.verify('HMAC',key,bytes,new TextEncoder().encode(entry.channel+'\n'+envelope.seq+'\n'+envelope.text));
 }
 return {verify};
});
