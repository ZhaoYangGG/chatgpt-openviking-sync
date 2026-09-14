import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {publicFiles,v1Files,v2Files} from './release-files.mjs';
import {audit} from './audit-public.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--output'))throw Error('Usage: --output <new-directory>');
const output=path.resolve(root,args[1]||'dist/release');
if(fs.existsSync(output))throw Error('Output already exists; choose a new --output directory. Nothing overwritten.');
if(output===root||root.startsWith(output+path.sep))throw Error('Output must not be a source ancestor.');
fs.mkdirSync(output,{recursive:true});
const source=path.join(output,'source');
fs.mkdirSync(source);
function stripPngMetadata(data) {
  const signature=Buffer.from([137,80,78,71,13,10,26,10]);
  if(!data.subarray(0,8).equals(signature))throw Error('Invalid PNG');
  const chunks=[signature];let p=8;
  while(p+12<=data.length) {
    const length=data.readUInt32BE(p),kind=data.toString('ascii',p+4,p+8),end=p+length+12;
    if(end>data.length)throw Error('Invalid PNG chunk');
    // Only remove metadata; original pixel/compression chunks are copied byte-for-byte.
    if(!['eXIf','iTXt','tEXt','zTXt','tIME'].includes(kind))chunks.push(data.subarray(p,end));
    p=end;
  }
  if(p!==data.length)throw Error('Unexpected PNG trailing data');
  return Buffer.concat(chunks);
}
for(const file of publicFiles) {
  let cursor=root;
  for(const segment of file.split('/')) {
    cursor=path.join(cursor,segment);
    if(fs.lstatSync(cursor).isSymbolicLink())throw Error('Symlink rejected: '+file);
  }
  if(!fs.statSync(cursor).isFile())throw Error('Not a file: '+file);
  const target=path.join(source,file);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  if(file.endsWith('.png'))fs.writeFileSync(target,stripPngMetadata(fs.readFileSync(cursor)));
  else fs.copyFileSync(cursor,target);
}
// Do not advertise/package experimental Safari scripts from the private development tree.
const pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
delete pkg.scripts['sync:safari'];
delete pkg.author;delete pkg.contributors;delete pkg.repository;delete pkg.homepage;delete pkg.bugs;
fs.writeFileSync(path.join(source,'package.json'),JSON.stringify(pkg,null,2)+'\n');
const result=audit(source);
if(!result.ok) {
  console.error(JSON.stringify(result,null,2));
  throw Error('Public source audit failed. No ZIPs created.');
}

// Dependency-free deterministic ZIP (STORE). No uid/gid, extra fields or local timestamps.
function crc32(buf) {
  let crc=0xffffffff;
  for(const value of buf){crc^=value;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
function zip(entries) {
  const locals=[],central=[];let offset=0;
  for(const [name,data] of entries.sort((a,b)=>a[0].localeCompare(b[0],'en'))) {
    if(name.startsWith('/')||name.split('/').includes('..')||name.includes('\\'))throw Error('Unsafe ZIP name');
    const n=Buffer.from(name),crc=crc32(data);
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);
    h.writeUInt16LE(0x800,6);h.writeUInt16LE(0x5021,12);
    h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);
    c.writeUInt16LE(0x800,8);c.writeUInt16LE(0x5021,14);
    c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);
    c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);
    locals.push(h,n,data);central.push(c,n);offset+=h.length+n.length+data.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,cd,end]);
}
const read=file=>fs.readFileSync(path.join(source,file));
const v1Version=JSON.parse(read('manifest.json')).version,v2Version=JSON.parse(read('manifest.v2-preview.json')).version;
const legal=['LICENSE','SECURITY.md','PRIVACY.md'].map(f=>[f,read(f)]);
const bundles=[
  ['chatgpt-openviking-source.zip',publicFiles.map(f=>['chatgpt-openviking-sync/'+f,read(f)])],
  [`chatgpt-openviking-v1-${v1Version}.zip`,[...v1Files.map(f=>[f,read(f)]),...legal,
    ['INSTALL.txt',Buffer.from('V1 DOM sync preview. Configure your own OpenViking. Read SECURITY.md before enabling uploads. Unzip, then load this directory in Chrome developer mode.\n')]]],
  [`chatgpt-openviking-v2-preview-${v2Version}.zip`,[['manifest.json',read('manifest.v2-preview.json')],
    ...v2Files.map(f=>[f,read(f)]),...legal,
    ['INSTALL.txt',Buffer.from('V2 LOCAL CAPTURE ONLY. No uploads. Page payload authenticity is unresolved. Unzip and load this directory in Chrome developer mode; refresh a non-sensitive test conversation. See SECURITY.md.\n')]]]
];
const hashes=[];
for(const [name,entries] of bundles) {
  const data=zip(entries);fs.writeFileSync(path.join(output,name),data);
  hashes.push(createHash('sha256').update(data).digest('hex')+'  '+name);
}
fs.writeFileSync(path.join(output,'SHA256SUMS'),hashes.join('\n')+'\n');
console.log(JSON.stringify({status:'packaged',sourceFiles:result.files,output,bundles:bundles.map(b=>b[0])},null,2));
