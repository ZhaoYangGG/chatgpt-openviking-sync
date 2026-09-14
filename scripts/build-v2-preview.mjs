import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const destination=path.join(root,'dist/chrome-v2-preview');
const files=['src/shared/core.js','src/capture/bridge.js','src/capture/parser.js','src/capture/relay.js',
  'src/background/message-store.js','src/background/v2-service-worker.js',
  'src/popup/v2-popup.html','src/popup/v2-popup.js','src/popup/popup.css','src/popup/v2-popup.css'];
fs.mkdirSync(destination,{recursive:true});
fs.copyFileSync(path.join(root,'manifest.v2-preview.json'),path.join(destination,'manifest.json'));
for(const file of files){const target=path.join(destination,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,file),target);}
console.log(`V2 capture-only preview built: ${destination}`);
