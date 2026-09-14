import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicFiles} from './release-files.mjs';

// Findings report only the filename and rule, never the matched secret.
export function audit(root) {
  const findings=[], allowed=new Set(publicFiles);
  const rules=[
    ['local-user-path', /\/(?:Users|home)\/[^\s/'"<>]+/],
    ['mac-temporary-path', /\/(?:private\/)?var\/folders\//],
    ['windows-user-path', /[a-z]:[\\/]Users[\\/][^\s]+/i],
    ['email-address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
    ['real-looking-conversation-id', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
    ['credential', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
    ['credential-in-url', /https?:\/\/[^\s/"']+:[^\s/"']+@/],
    ['personal-extension-id', /chrome-extension:\/\/[a-p]{32}\//]
  ];
  const seen=[];
  function walk(dir,rel='') {
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const name=rel?rel+'/'+entry.name:entry.name, full=path.join(dir,entry.name);
      if(entry.isSymbolicLink()){findings.push([name,'symlink']);continue;}
      if(entry.isDirectory()) {
        // Generated/dependency/git contents are not source artifacts.
        if(!rel&&['.git','node_modules','dist'].includes(entry.name))continue;
        walk(full,name);continue;
      }
      seen.push(name);
      if(!allowed.has(name)){findings.push([name,'outside-public-allowlist']);continue;}
      const b=fs.readFileSync(full);
      if(name.endsWith('.png')) {
        const safeChunks=new Set(['IHDR','IDAT','IEND','PLTE','tRNS','sRGB','gAMA','cHRM','pHYs']);
        if(!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))findings.push([name,'invalid-png']);
        let p=8;
        while(p+12<=b.length) {
          const len=b.readUInt32BE(p),kind=b.toString('ascii',p+4,p+8);
          if(p+len+12>b.length){findings.push([name,'invalid-png-chunk']);break;}
          if(!safeChunks.has(kind))findings.push([name,'unexpected-png-metadata:'+kind]);
          p+=len+12;
        }
        continue;
      }
      const text=b.toString('utf8');
      for(const [label,re] of rules) if(re.test(text))findings.push([name,label]);
      for(const m of text.matchAll(/\b(?:apiKey|api_key|password|secret)\s*:\s*["']([^"'\r\n]+)["']/g)) {
        if(!['secret-test-key','DO_NOT_EXPORT_SECRET'].includes(m[1]))findings.push([name,'literal-credential-review']);
      }
    }
  }
  walk(root);
  for(const name of allowed) if(!seen.includes(name))findings.push([name,'missing-public-file']);
  return {ok:findings.length===0,files:seen.length,findings};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=path.resolve(process.argv[2]||'.');
  const result=audit(root);
  console.log(JSON.stringify(result,null,2));
  if(!result.ok)process.exitCode=1;
}
