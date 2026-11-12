import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dir=process.env.CINEMA_DATA_DIR || fileURLToPath(new URL('../',import.meta.url));
const redisPrefix='remedium-cinema:v1:'+(process.env.RENDER_SERVICE_ID||'default');

async function redisValue(key) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  const url=new URL(process.env.UPSTASH_REDIS_REST_URL);
  if (url.protocol!=='https:' || !url.hostname.endsWith('.upstash.io') || url.username || url.password) throw new Error('Invalid legacy storage address');
  const res=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{Authorization:'Bearer '+process.env.UPSTASH_REDIS_REST_TOKEN,'Content-Type':'application/json'},
    body:JSON.stringify(['GET',redisPrefix+key])});
  if(!res.ok) throw new Error('Legacy storage unavailable');
  const data=await res.json();
  if(data.error) throw new Error('Legacy storage unavailable');
  return data.result==null?null:JSON.parse(data.result);
}

async function readJson(name,fallback) {
  try { return JSON.parse(await fs.readFile(path.join(dir,name),'utf8')); }
  catch(error) { if(error.code==='ENOENT') return fallback; throw error; }
}

async function legacyAccount() {
  const account=await redisValue(':owner');
  if(!account) return null;
  if(account.version!==1 || typeof account.login!=='string' || !/^[a-f0-9]{32}$/.test(account.salt||'')
      || !/^[a-f0-9]{64}$/.test(account.hash||'') || !/^[a-f0-9]{32}$/.test(account.roomId||'')) {
    throw new Error('Invalid legacy account');
  }
  return account;
}

export async function legacyCredentials(login,password,normalize,equal) {
  if (normalize(process.env.CINEMA_ADMIN_LOGIN)===login && equal(password,process.env.CINEMA_ADMIN_PASSWORD)) return true;
  const old=await legacyAccount();
  if (!old || normalize(old.login)!==login) return false;
  const derived=await new Promise((resolve,reject)=>{
    crypto.scrypt(password,Buffer.from(old.salt,'hex'),32,{N:32768,r:8,p:3,maxmem:64*1024*1024},
      (error,hash)=>error?reject(error):resolve(hash));
  });
  return crypto.timingSafeEqual(derived,Buffer.from(old.hash,'hex'));
}

export async function loadLegacyCreatorRoom() {
  const old=await legacyAccount();
  const secret=process.env.CINEMA_ADMIN_SECRET;
  const id=process.env.CINEMA_LEGACY_ROOM_ID || old?.roomId ||
    (secret?.length>=32 ? crypto.createHmac('sha256',secret).update('admin-room').digest('hex').slice(0,32):null);
  if(!id || !/^[\w-]{3,80}$/.test(id)) return null;
  const snapshot=old && await redisValue(':room:'+id);
  if(snapshot?.room) return {id,state:snapshot.room,history:Array.isArray(snapshot.history)?snapshot.history:[]};
  const saved=await readJson('cinema-data.json',{});
  const history=await readJson('cinema-history.json',[]);
  return {id,state:saved[id]||{},history:Array.isArray(history)?history.filter(item=>item?.room===id):[]};
}
