(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.OpenVikingSourceTime=api;})(globalThis,function(){
  'use strict';
  // JSON.parse validates syntax; this bounded traversal additionally retains numeric lexemes.
  function parseExact(text) {
    if(typeof text!=='string'||text.length>2*1024*1024)throw Error('capture_limit');
    const data=JSON.parse(text),tokens=text.match(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g)||[];
    let i=0;const times=new Map();
    function value(path,depth){
      if(depth>64)throw Error('json_depth_limit');
      const t=tokens[i++];
      if(t==='{'){
        const keys=new Set();
        if(tokens[i]==='}'){i++;return;}
        do{
          const key=JSON.parse(tokens[i++]);if(keys.has(key))throw Error('duplicate_json_key');keys.add(key);
          if(tokens[i++]!==':')throw Error('invalid_json');
          value([...path,key],depth+1);
          if(tokens[i]!==',')break;i++;
        }while(true);
        if(tokens[i++]!=='}')throw Error('invalid_json');
      }else if(t==='['){
        let index=0;if(tokens[i]===']'){i++;return;}
        do{value([...path,index++],depth+1);if(tokens[i]!==',')break;i++;}while(true);
        if(tokens[i++]!==']')throw Error('invalid_json');
      }else if(path.length===3&&path[0]==='messages'&&['create_time','update_time'].includes(path[2])){
        if(/^-?\d/.test(t))times.set(path[1]+':'+path[2],t);
      }
    }
    value([],0);if(i!==tokens.length)throw Error('invalid_json');
    return {data,times};
  }
  function toIso(raw){
    if(typeof raw!=='string'||raw.length>80)throw Error('missing_source_time');
    const m=/^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
    if(!m)throw Error('invalid_source_time');
    const exponent=Number(m[3]||0);if(Math.abs(exponent)>20)throw Error('invalid_source_time');
    const digits=m[1]+(m[2]||''),point=m[1].length+exponent;
    const integer=point<=0?'0':digits.slice(0,point).padEnd(point,'0');
    const fraction=(point<=0?'0'.repeat(-point)+digits:point<digits.length?digits.slice(point):'').replace(/0+$/,'');
    const seconds=BigInt(integer);if(seconds>253402300799n)throw Error('invalid_source_time');
    const whole=new Date(Number(seconds)*1000).toISOString().slice(0,19);
    return whole+(fraction?'.'+fraction:'')+'Z';
  }
  return {parseExact,toIso};
});
