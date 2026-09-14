import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {v2SyncFiles} from './release-files.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const destination=path.join(root,'dist/chrome-v2');
fs.mkdirSync(destination,{recursive:true});
fs.copyFileSync(path.join(root,'manifest.v2.json'),path.join(destination,'manifest.json'));
for(const file of v2SyncFiles){const target=path.join(destination,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,file),target);}
console.log('V2 sync extension built: '+destination);
