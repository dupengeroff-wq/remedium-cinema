import crypto from 'node:crypto';
import argon2 from 'argon2';
import {query,transaction} from './db.js';
import {ensure,HttpError,limiter,text,uuid,wrap} from './http.js';
import {legacyCredentials} from './legacy.js';

const cookie = '__Host-rc-session';
const ttl = 30*24*60*60*1000;
const cookieOptions = {httpOnly:true,secure:true,sameSite:'lax',path:'/'};
const params = {type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:1};
const throttle = limiter(14,60000,req=>req.ip);
const accountThrottle = limiter(8,60000,req=>String(loginKey(req.body?.login)||req.ip));
let derivations = 0;
let dummy;
export const hashToken = value => crypto.createHash('sha256').update(value).digest('hex');
const random = (size=32) => crypto.randomBytes(size).toString('base64url');
const defaultPrivacy = {watchTime:false,films:false,sessions:false,shared:false,registration:false,history:false,friends:false,presence:false,hideStats:false};
export {defaultPrivacy};

function loginKey(value) {
  if (typeof value !== 'string' || value.length>100) return '';
  const result = value.normalize('NFKC').trim().toLowerCase();
  return /^[\p{L}\p{N}_.-]{3,40}$/u.test(result) ? result : '';
}
function validPassword(value) { return typeof value==='string' && value.length>=12 && value.length<=128; }
function validateNewPassword(password,confirmation) {
  ensure(validPassword(password),400,'Пароль должен содержать 12–128 символов.');
  ensure(password===confirmation,400,'Пароли не совпадают.');
}
async function limited(work) {
  ensure(derivations < 2,429,'Сервер занят. Попробуй через несколько секунд.');
  derivations++;
  try { return await work(); } finally { derivations--; }
}
export function safeEqual(a,b) {
  return typeof a==='string' && typeof b==='string' &&
    crypto.timingSafeEqual(Buffer.from(hashToken(a),'hex'),Buffer.from(hashToken(b),'hex'));
}
function sessionToken(req) {
  const raw = (req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith(cookie+'='));
  const token = raw?.slice(cookie.length+1);
  return /^[A-Za-z0-9_-]{43}$/.test(token||'') ? token : null;
}
export const publicUser = row => ({id:row.id,login:row.login,nickname:row.nickname,role:row.role,avatar:row.avatar_key?'/api/avatars/'+row.id:null,friendCode:row.friend_code});

export async function authFor(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const {rows:[row]} = await query(`
    SELECT u.id,u.login,u.nickname,u.role,u.avatar_key,u.friend_code,s.id AS session_id,s.expires_at,s.last_seen_at
    FROM auth_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`,[hashToken(token)]);
  if (!row) return null;
  if (Date.now()-new Date(row.last_seen_at).getTime()>600000) {
    query('UPDATE auth_sessions SET last_seen_at=now() WHERE id=$1',[row.session_id]).catch(()=>{});
  }
  return row;
}

export async function sessionActive(auth) {
  if (!auth || Date.now()>=new Date(auth.expires_at).getTime()) return false;
  return !!(await query('SELECT 1 FROM auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()',[auth.session_id,auth.id])).rowCount;
}

export function requireUser(handler) {
  return wrap(async (req,res,next) => {
    req.user = await authFor(req);
    ensure(req.user,401,'Войди в аккаунт.');
    await handler(req,res,next);
  });
}

async function issueSession(req,res,user) {
  const token=random();
  await transaction(async client=>{
    const {rowCount}=await client.query('SELECT 1 FROM users WHERE id=$1 AND password_hash=$2 FOR UPDATE',[user.id,user.password_hash]);
    ensure(rowCount,409,'Пароль изменился. Войди с актуальным паролем.');
    await client.query('INSERT INTO auth_sessions(id,user_id,token_hash,user_agent,expires_at) VALUES ($1,$2,$3,$4,$5)',
      [crypto.randomUUID(),user.id,hashToken(token),text(req.headers['user-agent'],200),new Date(Date.now()+ttl)]);
  });
  res.cookie(cookie,token,{...cookieOptions,maxAge:ttl});
}

async function createCodes(client,userId) {
  const codes=Array.from({length:8},()=>random(18));
  await client.query('DELETE FROM recovery_codes WHERE user_id=$1',[userId]);
  await client.query('INSERT INTO recovery_codes(user_id,code_hash) SELECT $1,unnest($2::text[])',[userId,codes.map(hashToken)]);
  return codes;
}

async function createUser(login,nickname,password,creator) {
  const hash=await argon2.hash(password,params);
  try {
    return await transaction(async client=>{
      const id=crypto.randomUUID();
      const {rows:[user]}=await client.query(`
        INSERT INTO users(id,login,nickname,password_hash,friend_code,role)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id,login,nickname,hash,crypto.randomBytes(6).toString('hex'),creator?'creator':'member']);
      await client.query('INSERT INTO profile_privacy(user_id,settings) VALUES ($1,$2)',[id,JSON.stringify(defaultPrivacy)]);
      return {user,codes:await createCodes(client,id)};
    });
  } catch(error) {
    if(error.code==='23505') throw new HttpError(409,error.constraint==='users_one_creator'?'Роль создателя уже назначена.':'Этот логин занят.');
    throw error;
  }
}

async function revokeAll(userId,client) {
  const {rows}=await client.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL RETURNING id',[userId]);
  return rows.map(row=>row.id);
}

async function passwordRow(userId,password) {
  const {rows:[row]}=await query('SELECT password_hash FROM users WHERE id=$1',[userId]);
  ensure(validPassword(password) && row && await argon2.verify(row.password_hash,password),403,'Неверный текущий пароль.');
  return row.password_hash;
}

export function mountAuth(app,revokeSocket) {
  app.get('/api/auth/me',wrap(async (req,res)=>{
    const user=await authFor(req);
    res.json({user:user?publicUser(user):null});
  }));

  app.post('/api/auth/register',wrap(async (req,res)=>{
    throttle(req); accountThrottle(req);
    const {login:raw,nickname:rawName,password,confirmation,creatorCode}=req.body||{};
    const login=loginKey(raw), nickname=text(rawName,40);
    ensure(login && nickname,400,'Введи логин (3–40 букв, цифр или . _ -) и ник.');
    validateNewPassword(password,confirmation);
    const configured=process.env.CINEMA_CREATOR_SETUP_CODE||'';
    const creator=!!creatorCode;
    if (creator) ensure(configured.length>=24 && safeEqual(creatorCode,configured),403,'Неверный код создателя.');
    const reserved=loginKey(process.env.CINEMA_ADMIN_LOGIN);
    ensure(!reserved || login!==reserved || creator,409,'Этот логин зарезервирован. Войди прежним паролем или используй код создателя.');
    const {user,codes}=await limited(()=>createUser(login,nickname,password,creator));
    await issueSession(req,res,user);
    res.status(201).json({user:publicUser(user),recoveryCodes:codes});
  }));

  app.post('/api/auth/login',wrap(async (req,res)=>{
    throttle(req); accountThrottle(req);
    const login=loginKey(req.body?.login), password=req.body?.password;
    ensure(login && typeof password==='string' && password.length>0 && password.length<=128,400,'Введи логин и пароль.');
    const result=await limited(async ()=>{
      const {rows:[user]}=await query('SELECT * FROM users WHERE login=$1',[login]);
      if (user) {
        ensure(await argon2.verify(user.password_hash,password),401,'Неверный логин или пароль.');
        return {user};
      }
      const creator=(await query("SELECT 1 FROM users WHERE role='creator'")).rowCount;
      if (!creator && await legacyCredentials(login,password,loginKey,safeEqual)) {
        // Very old short passwords must be replaced through protected creator registration.
        ensure(validPassword(password),403,'Прежний пароль короче 12 символов. Зарегистрируйся с новым паролем и кодом создателя.');
        return createUser(login,login,password,true);
      }
      dummy ||= argon2.hash(random(),params);
      await argon2.verify(await dummy,password);
      throw new HttpError(401,'Неверный логин или пароль.');
    });
    await issueSession(req,res,result.user);
    res.json({user:publicUser(result.user),...(result.codes?{recoveryCodes:result.codes}:{})});
  }));

  app.post('/api/auth/logout',requireUser(async (req,res)=>{
    await query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[req.user.session_id]);
    revokeSocket(req.user.session_id);
    res.clearCookie(cookie,cookieOptions).json({ok:true});
  }));

  app.get('/api/auth/sessions',requireUser(async (req,res)=>{
    const {rows}=await query(`SELECT id,user_agent,created_at,last_seen_at,expires_at
      FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()
      ORDER BY created_at DESC LIMIT 100`,[req.user.id]);
    res.json({sessions:rows.map(row=>({...row,current:row.id===req.user.session_id}))});
  }));
  app.delete('/api/auth/sessions/:id',requireUser(async (req,res)=>{
    ensure(uuid(req.params.id),404,'Сеанс не найден.');
    const {rowCount}=await query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',[req.params.id,req.user.id]);
    ensure(rowCount,404,'Сеанс не найден.');
    revokeSocket(req.params.id);
    if(req.params.id===req.user.session_id) res.clearCookie(cookie,cookieOptions);
    res.json({ok:true});
  }));

  app.post('/api/auth/password',requireUser(async (req,res)=>{
    throttle(req);
    validateNewPassword(req.body?.password,req.body?.confirmation);
    const result=await limited(async ()=>{
      const before=await passwordRow(req.user.id,req.body?.currentPassword);
      const hash=await argon2.hash(req.body.password,params);
      return transaction(async client=>{
        const change=await client.query('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2 AND password_hash=$3',[hash,req.user.id,before]);
        ensure(change.rowCount,409,'Пароль уже изменился. Войди снова.');
        const revoked=await revokeAll(req.user.id,client);
        return {revoked,hash,codes:await createCodes(client,req.user.id)};
      });
    });
    result.revoked.forEach(revokeSocket);
    await issueSession(req,res,{...req.user,password_hash:result.hash});
    res.json({ok:true,recoveryCodes:result.codes});
  }));

  app.post('/api/auth/recovery-codes',requireUser(async (req,res)=>{
    throttle(req);
    const codes=await limited(async ()=>{
      const hash=await passwordRow(req.user.id,req.body?.password);
      return transaction(async client=>{
        const {rowCount}=await client.query('SELECT 1 FROM users WHERE id=$1 AND password_hash=$2 FOR UPDATE',[req.user.id,hash]);
        ensure(rowCount,409,'Пароль уже изменился. Войди снова.');
        return createCodes(client,req.user.id);
      });
    });
    res.json({recoveryCodes:codes});
  }));

  app.post('/api/auth/recover',wrap(async (req,res)=>{
    throttle(req); accountThrottle(req);
    const login=loginKey(req.body?.login), code=text(req.body?.code,100);
    validateNewPassword(req.body?.password,req.body?.confirmation);
    ensure(login && /^[A-Za-z0-9_-]{24}$/.test(code),400,'Введи логин и резервный код.');
    const result=await limited(async ()=>{
      const hash=await argon2.hash(req.body.password,params);
      return transaction(async client=>{
        const {rows:[user]}=await client.query('SELECT id FROM users WHERE login=$1 FOR UPDATE',[login]);
        ensure(user,403,'Неверный логин или резервный код.');
        const removed=await client.query('DELETE FROM recovery_codes WHERE user_id=$1 AND code_hash=$2',[user.id,hashToken(code)]);
        ensure(removed.rowCount,403,'Неверный логин или резервный код.');
        await client.query('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2',[hash,user.id]);
        return {revoked:await revokeAll(user.id,client)};
      });
    });
    result.revoked.forEach(revokeSocket);
    res.clearCookie(cookie,cookieOptions).json({ok:true});
  }));
}
