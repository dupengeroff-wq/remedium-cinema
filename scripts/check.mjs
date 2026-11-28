import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
const files=['server.js','media.js'];
function collect(dir) {
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
    const name=join(dir,entry.name);
    if(entry.isDirectory()) collect(name);
    else if(entry.isFile() && /\.m?js$/.test(entry.name)) files.push(name);
  }
}
for(const dir of ['lib','src','public','test','scripts']) collect(dir);
for(const file of files.sort()) {
  const check=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
  if(check.status!==0) process.exit(check.status||1);
}
console.log('Syntax checked: '+files.length+' JS/MJS files');
