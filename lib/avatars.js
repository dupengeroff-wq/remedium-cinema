import crypto from 'node:crypto';
import express from 'express';
import sharp from 'sharp';
import {query,transaction} from './db.js';
import {requireUser} from './auth.js';
import {ensure,limiter,uuid,wrap} from './http.js';

const bucket=process.env.SUPABASE_AVATAR_BUCKET||'avatars';
const quota=limiter(8,60000,req=>req.user.id);
const maxBytes=5*1024*1024;

function storage(path,options={}) {
  const raw=process.env.SUPABASE_URL, key=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;
  ensure(raw && key && /^[A-Za-z0-9_-]{1,60}$/.test(bucket),503,'Хранилище аватаров ещё не настроено.');
  const base=new URL(raw);
  ensure(base.protocol==='https:' && base.hostname.endsWith('.supabase.co') &&
    !base.username && !base.password && !base.port,503,'Адрес хранилища аватаров некорректен.');
  const authHeaders=key.startsWith('sb_secret_')?{apikey:key}:{apikey:key,Authorization:'Bearer '+key};
  return fetch(new URL('/storage/v1/'+path,base),{...options,redirect:'error',signal:AbortSignal.timeout(7000),
    headers:{...authHeaders,...options.headers}});
}

async function remove(key) {
  if (!key || !validKey(key)) return;
  const res=await storage('object/'+bucket,{method:'DELETE',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({prefixes:[key]})});
  if(!res.ok) throw new Error('avatar removal failed');
}
function validKey(key) { return /^[a-f0-9-]{36}\/[a-f0-9-]{36}\.webp$/.test(key); }

export function mountAvatars(app) {
  app.get('/api/avatars/:id',requireUser(async (req,res)=>{
    ensure(uuid(req.params.id),404,'Фото не найдено.');
    const {rows:[row]}=await query('SELECT avatar_key FROM users WHERE id=$1',[req.params.id]);
    ensure(row?.avatar_key && validKey(row.avatar_key),404,'Фото не найдено.');
    const remote=await storage('object/authenticated/'+bucket+'/'+row.avatar_key);
    ensure(remote.ok,404,'Фото недоступно.');
    const data=Buffer.from(await remote.arrayBuffer());
    ensure(data.length<=1024*1024,502,'Фото повреждено.');
    res.type('webp').set('Cache-Control','private, no-store').send(data);
  }));
  const authorizeUpload=requireUser((req,_,next)=>{
    quota(req);
    next();
  });
  app.put('/api/profile/avatar',authorizeUpload,express.raw({type:'application/octet-stream',limit:maxBytes}),wrap(async (req,res)=>{
    ensure(Buffer.isBuffer(req.body)&&req.body.length,400,'Выбери фото в формате JPEG, PNG или WebP.');
    let bytes;
    try {
      const image=sharp(req.body,{limitInputPixels:20000000,failOn:'warning'});
      const info=await image.metadata();
      if (!['jpeg','png','webp'].includes(info.format) || (info.pages||1)>1) throw new Error('unsupported');
      bytes=await image.rotate().resize(256,256,{fit:'cover'}).webp({quality:82}).toBuffer();
    } catch { ensure(false,400,'Фото повреждено или слишком большое. Допустимы JPEG, PNG и WebP.'); }
    const key=req.user.id+'/'+crypto.randomUUID()+'.webp';
    const response=await storage('object/'+bucket+'/'+key,{method:'POST',
      headers:{'Content-Type':'image/webp','x-upsert':'false'},body:bytes});
    ensure(response.ok,503,'Не удалось сохранить фото.');
    try {
      const old=await transaction(async client=>{
        const {rows:[row]}=await client.query('SELECT avatar_key FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
        await client.query('UPDATE users SET avatar_key=$2,updated_at=now() WHERE id=$1',[req.user.id,key]);
        return row.avatar_key;
      });
      await remove(old).catch(()=>console.warn('Old avatar cleanup pending'));
    } catch(error) { await remove(key).catch(()=>{}); throw error; }
    res.json({avatar:'/api/avatars/'+req.user.id});
  }));
  app.delete('/api/profile/avatar',requireUser(async (req,res)=>{
    quota(req);
    await transaction(async client=>{
      const {rows:[row]}=await client.query('SELECT avatar_key FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
      await remove(row.avatar_key);
      await client.query('UPDATE users SET avatar_key=NULL,updated_at=now() WHERE id=$1',[req.user.id]);
    });
    res.json({avatar:null});
  }));
}
