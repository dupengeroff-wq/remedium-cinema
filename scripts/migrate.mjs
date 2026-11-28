import {migrationAllowed} from '../src/server/db/migrations.js';
if(!migrationAllowed(process.env)){
  console.error('Migration blocked: isolated loopback test DB, NODE_ENV=test and REMEDIUM_RUN_MIGRATIONS=1 required.');
  process.exitCode=1;
}else{
  const {runMigrations,close}=await import('../src/server/db/pool.js');
  try {await runMigrations();console.log('Isolated test migrations applied.');}
  catch(error){console.error('Migration failed:',error.code||error.name);process.exitCode=1;}
  finally{await close();}
}
