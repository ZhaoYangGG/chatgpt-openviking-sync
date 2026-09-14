(function installP0Bridge() {
  'use strict';
  const marker=Symbol.for('openviking.p0.capture.installed');
  if (globalThis[marker]) return;
  globalThis[marker]=true;
  const nativeFetch=globalThis.fetch;
  const MAX_BYTES=2*1024*1024, MAX_ACTIVE=2;
  let active=0, sequence=0, notified=0, windowStart=0;
  function emit(value) {
    const now=Date.now();
    if (now-windowStart>1000) {windowStart=now;notified=0;}
    if (++notified>12) return;
    globalThis.postMessage({type:'OV_P0_CAPTURE_V1',...value},'https://chatgpt.com');
  }
  function target(input, init) {
    try {
      const method=String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
      if (method !== 'GET') return null;
      const url=new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url,location.href);
      if (url.origin !== 'https://chatgpt.com') return null;
      const match=url.pathname.match(/^\/backend-api\/(conversations|conversation)\/([a-zA-Z0-9_-]{1,160})\/?$/);
      if (!match) return null;
      const query=Array.from(url.searchParams,([key,val])=>({
        key:key.slice(0,100), value:/^(num_turns|include_has_versions|cursor|before|after|start_cursor|end_cursor)$/.test(key)
          && /^[a-zA-Z0-9_.:-]{0,200}$/.test(val) ? val : '[redacted]'})).slice(0,30);
      return {conversationId:match[2],path:url.pathname,query};
    } catch { return null; }
  }
  async function observe(response, info) {
    const event={...info,requestId:`${performance.timeOrigin}:${++sequence}`,capturedAt:Date.now(),httpStatus:response.status};
    if (!response.ok || !/\bjson\b/i.test(response.headers.get('content-type') || '')) {
      emit({...event,error:'not_successful_json'}); return;
    }
    const length=Number(response.headers.get('content-length'));
    if (length>MAX_BYTES || active>=MAX_ACTIVE) { emit({...event,error:'capture_limit'}); return; }
    active++;
    let reader, timer;
    try {
      reader=response.clone().body.getReader();
      let expired=false;
      timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},15000);
      const decoder=new TextDecoder(),chunks=[];
      let size=0;
      for (;;) {
        const {done,value}=await reader.read();
        if (expired) throw new Error('capture_timeout');
        if (done) break;
        size+=value.byteLength;
        if (size>MAX_BYTES) {void reader.cancel().catch(()=>{});throw new Error('capture_limit');}
        chunks.push(decoder.decode(value,{stream:true}));
      }
      chunks.push(decoder.decode());
      emit({...event,bytes:size,body:chunks.join('')});
    } catch { emit({...event,error:'capture_failed_or_limit'}); }
    finally {clearTimeout(timer);active--;}
  }
  globalThis.fetch=function (...args) {
    // Preserve the original promise, original response, receiver and exceptions.
    const promise=Reflect.apply(nativeFetch,this,args);
    const info=target(args[0],args[1]);
    if (info) promise.then(response=>{void observe(response,info);},()=>{}).catch(()=>{});
    return promise;
  };
})();
