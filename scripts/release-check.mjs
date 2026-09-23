import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const root=process.cwd();
const files=[];
function walk(dir){for(const item of readdirSync(dir,{withFileTypes:true})){if(['node_modules','.git','dist'].includes(item.name)||item.name.endsWith('.tgz'))continue; const path=join(dir,item.name);if(item.isDirectory())walk(path);else files.push(path);}}
walk(root);
const patterns=[/gh[pousr]_[A-Za-z0-9]{30,}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/sk-[A-Za-z0-9]{24,}/,/C:\\Users\\/,/voice-agent-phonbot/,/drkalla/i];
const hits=[];
for(const file of files){if(file.endsWith('release-check.mjs'))continue;const data=readFileSync(file,'utf8');if(patterns.some(p=>p.test(data)))hits.push(relative(root,file));}
if(hits.length){console.error('Release scan requires review:',hits.join(', '));process.exitCode=1;}else console.log(`Release source scan: ${files.length} files; no configured secret/private-context patterns found. Manual review still required.`);
const deps=[];
function inventory(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){if(!entry.isDirectory()||entry.name.startsWith('.'))continue;const path=join(dir,entry.name);if(entry.name.startsWith('@')){inventory(path);continue;}try{const p=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));deps.push({name:p.name,version:p.version,license:p.license??'UNSPECIFIED'});}catch{}}}
inventory(join(root,'node_modules'));
writeFileSync(join(root,'docs','dependencies.json'),JSON.stringify(deps.sort((a,b)=>a.name.localeCompare(b.name)),null,2)+'\n');
console.log(`Dependency licenses: ${deps.length} installed packages; ${[...new Set(deps.map(p=>p.license))].join(', ')}`);
