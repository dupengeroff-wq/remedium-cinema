import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const files=['server.js','media.js','app.js','cinema-ui.js','account.js','navigation.js','social.js',
  ...readdirSync('lib').filter(name=>name.endsWith('.js')).map(name=>'lib/'+name)];
for (const file of files) {
  const check=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
  if(check.status!==0)process.exit(check.status||1);
}
