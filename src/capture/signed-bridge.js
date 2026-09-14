(function(root){
 'use strict';
 // Serialized by chrome.scripting; this function must not reference outer variables.
 function install(secret,channel){
  const marker=Symbol.for('openviking.signed.capture.v1');
  if(globalThis[marker])return 'already_installed';
  Object.defineProperty(globalThis,marker,{value:true});
  const fetchOriginal=globalThis.fetch,post=globalThis.postMessage.bind(globalThis);
  const stringify=JSON.stringify.bind(JSON),encoder=new TextEncoder();
  const subtle=crypto.subtle,sign=subtle.sign.bind(subtle);
  const key=subtle.importKey('raw',new Uint8Array(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  let active=0,sequence=0,emissions=0,windowAt=0,chain=Promise.resolve();
  function emit(payload){
    const now=Date.now();if(now-windowAt>1000){windowAt=now;emissions=0;}
    if(++emissions>13)return;
    if(emissions===13)payload={id:payload.id,error:'capture_limit'};
    const text=stringify(payload),seq=++sequence;
    chain=chain.then(async()=>{
      const signature=await sign('HMAC',await key,encoder.encode(channel+'\n'+seq+'\n'+text));
      const mac=Array.from(new Uint8Array(signature),n=>n.toString(16).padStart(2,'0')).join('');
      post({type:'OV_V2_SIGNED',channel,seq,text,mac},'https://chatgpt.com');
    }).catch(()=>{});
  }
  function target(input,init){
    try{
      if(String(init?.method||input?.method||'GET').toUpperCase()!=='GET')return null;
      const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,location.href);
      const match=url.pathname.match(/^\/backend-api\/(?:conversations|conversation)\/([a-zA-Z0-9_-]{1,160})\/?$/);
      return url.origin==='https://chatgpt.com'&&match?match[1]:null;
    }catch{return null;}
  }
  async function observe(response,id){
    if(!response.ok||!/\bjson\b/i.test(response.headers.get('content-type')||'')){emit({id,error:'not_successful_json'});return;}
    if(active>=2||Number(response.headers.get('content-length'))>2097152){emit({id,error:'capture_limit'});return;}
    active++;let reader,timer,expired=false;
    try{
      reader=response.clone().body.getReader();
      timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},15000);
      const decoder=new TextDecoder(),chunks=[];let bytes=0;
      for(;;){const {done,value}=await reader.read();if(expired)throw Error('timeout');if(done)break;
        bytes+=value.byteLength;if(bytes>2097152){void reader.cancel().catch(()=>{});throw Error('limit');}
        chunks.push(decoder.decode(value,{stream:true}));}
      chunks.push(decoder.decode());emit({id,body:chunks.join('')});
    }catch{emit({id,error:'capture_failed_or_limit'});}
    finally{clearTimeout(timer);active--;}
  }
  globalThis.fetch=function(...args){
    const promise=Reflect.apply(fetchOriginal,this,args),id=target(args[0],args[1]);
    if(id)promise.then(r=>{void observe(r,id).catch(()=>{});},()=>{}).catch(()=>{});
    return promise;
  };
  return 'installed';
 }
 root.OpenVikingSignedBridge={install};
 if(typeof module==='object'&&module.exports)module.exports={install};
})(globalThis);
