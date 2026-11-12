import fs from 'node:fs/promises';
import path from 'node:path';

const real=globalThis.fetch;
globalThis.fetch=async(input,options={})=>{
  const url=new URL(input);
  if(url.hostname!=='cinema-avatar-fixture.supabase.co') return real(input,options);
  if(options.headers?.apikey!=='sb_secret_fixture-only' || options.headers.Authorization) {
    return new Response('{}',{status:401});
  }
  const folder=process.env.TEST_AVATAR_DIR;
  const prefix='/storage/v1/object/';
  const key=url.pathname.slice(prefix.length).replace(/^authenticated\//,'').split('/').slice(1).join('_');
  if(options.method==='DELETE'){
    for(const item of JSON.parse(options.body).prefixes) await fs.unlink(path.join(folder,item.replaceAll('/','_'))).catch(()=>{});
    return new Response('{}',{status:200});
  }
  const destination=path.join(folder,key);
  if(options.method==='POST'){
    await fs.writeFile(destination,Buffer.from(options.body),{flag:'wx'});
    return new Response('{}',{status:200});
  }
  try{return new Response(await fs.readFile(destination),{headers:{'Content-Type':'image/webp'}})}
  catch{return new Response('',{status:404})}
};
