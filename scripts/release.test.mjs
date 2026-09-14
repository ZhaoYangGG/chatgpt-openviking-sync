import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {audit} from './audit-public.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('release audit rejects private-looking text without echoing it',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ov-audit-'));
  try {
    const email=['synthetic','example.invalid'].join('@');
    fs.writeFileSync(path.join(dir,'README.md'),email);
    const r=audit(dir);assert.equal(r.ok,false);
    assert.ok(r.findings.some(f=>f[1]==='email-address'));
    assert.equal(JSON.stringify(r).includes(email),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('packaging succeeds; private extras excluded; existing output refused',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ov-package-')),out=path.join(temp,'release');
  try{
    const run=()=>spawnSync(process.execPath,['scripts/package-release.mjs','--output',out],{cwd:root,encoding:'utf8'});
    const a=run();assert.equal(a.status,0,a.stdout+a.stderr);
    assert.equal(audit(path.join(out,'source')).ok,true);
    assert.equal(fs.existsSync(path.join(out,'source/docs/evidence')),false);
    const b=run();assert.notEqual(b.status,0);assert.match(b.stderr,/Output already exists/);
    for(const n of ['chatgpt-openviking-source.zip','chatgpt-openviking-v1-0.1.0.zip','chatgpt-openviking-v2-preview-0.2.0.zip']){
      const data=fs.readFileSync(path.join(out,n));assert.equal(data.readUInt32LE(0),0x04034b50);
      assert.equal(data.readUInt32LE(data.length-22),0x06054b50);
    }
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
