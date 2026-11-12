import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PGlite} from '@electric-sql/pglite';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {io} from 'socket.io-client';
import sharp from 'sharp';
import {advanceEvidence} from '../lib/watch.js';
import {parseMedia} from '../media.js';

test('confirmed clock intervals reject frozen playback, jumps and repeated slots',()=>{
  const sample=(at,position,epoch=0)=>({at,position,epoch,mediaId:'film'});
  let a=advanceEvidence(null,sample(1000,20));
  a=advanceEvidence(a.state,sample(3500,22.5));
  a=advanceEvidence(a.state,sample(6000,25));
  a=advanceEvidence(a.state,sample(8500,27.5));
  a=advanceEvidence(a.state,sample(11000,30));
  assert.deepEqual(a.slots,[1]);
  assert.deepEqual(advanceEvidence(a.state,sample(11500,30.5)).slots,[]);
  assert.deepEqual(advanceEvidence(a.state,sample(14000,30)).slots,[]);
  assert.deepEqual(advanceEvidence(a.state,sample(14000,80)).slots,[]);
  assert.deepEqual(advanceEvidence(a.state,sample(18000,37)).slots,[]);
  assert.deepEqual(advanceEvidence(a.state,sample(14000,33,1)).slots,[]);
});

test('keeps supported media parsing',()=>{
  assert.equal(parseMedia('https://youtu.be/abcdefghijk').type,'youtube');
  assert.equal(parseMedia('https://vk.com/video_ext.php?oid=-12&id=34&hash=demo').type,'vk');
  assert.equal(parseMedia('https://media.example/movie.mp4').type,'video');
  assert.equal(parseMedia('javascript:alert(1)'),null);
});

async function freePort(){
  const server=net.createServer();
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const {port}=server.address();
  await new Promise(resolve=>server.close(resolve));
  return port;
}
async function until(check,timeout=14000){
  const start=Date.now();
  while(Date.now()-start<timeout){
    try{if(await check())return}catch{}
    await delay(100);
  }
  throw new Error('Timed out');
}
const pass='Example Cinema Password 321!';
const setupCode='test-only-creator-setup-secret-9876';
const legacySecret='test-only-legacy-cinema-secret-7391';

test('real HTTP + Socket.IO + PostgreSQL engine across restart', {timeout:90000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rc-neon-test-'));
  const avatars=path.join(dir,'avatars'),legacy=path.join(dir,'legacy');
  await Promise.all([fs.mkdir(avatars),fs.mkdir(legacy)]);
  const legacyRoom=crypto.createHmac('sha256',legacySecret).update('admin-room').digest('hex').slice(0,32);
  await fs.writeFile(path.join(legacy,'cinema-data.json'),JSON.stringify({[legacyRoom]:{hostName:'Старый ник'}}));
  await fs.writeFile(path.join(legacy,'cinema-history.json'),JSON.stringify([
    {room:legacyRoom,id:'old-movie',title:'Старый сеанс',at:'2026-01-01T00:00:00.000Z'}
  ]));
  const db=await PGlite.create();
  const gateway=new PGLiteSocketServer({db,port:0,host:'127.0.0.1',maxConnections:15});
  await gateway.start();
  const address=gateway.getServerConn();
  const endpoint=address.includes('://')?new URL(address):new URL('postgres://'+address);
  const database='postgresql://postgres:postgres@'+endpoint.host+'/postgres';
  const port=await freePort();
  const origin='http://127.0.0.1:'+port;
  let proc,logs='';
  const sockets=[];
  async function start(){
    proc=spawn(process.execPath,['--import','./test/avatar-storage-fixture.js','server.js'],{env:{
      ...process.env,NODE_ENV:'test',PORT:String(port),APP_ORIGIN:origin,DATABASE_URL:database,
      CINEMA_CREATOR_SETUP_CODE:setupCode,UPSTASH_REDIS_REST_URL:'',UPSTASH_REDIS_REST_TOKEN:'',
      CINEMA_ADMIN_LOGIN:'',CINEMA_ADMIN_SECRET:legacySecret,CINEMA_DATA_DIR:legacy,CINEMA_LEGACY_ROOM_ID:'',
      SUPABASE_URL:'https://cinema-avatar-fixture.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_fixture-only',
      TEST_AVATAR_DIR:avatars
    },stdio:['ignore','pipe','pipe']});
    proc.stdout.on('data',d=>logs+=d);
    proc.stderr.on('data',d=>logs+=d);
    try{await until(async()=> (await fetch(origin+'/ready',{signal:AbortSignal.timeout(800)})).ok);}
    catch(e){throw new Error(logs,{cause:e})}
  }
  async function stop(){
    for(const s of sockets.splice(0))s.disconnect();
    if(proc && proc.exitCode===null && proc.signalCode===null){
      proc.kill('SIGTERM');
      const killed=await Promise.race([once(proc,'exit').then(()=>true),delay(5000,false,{ref:false})]);
      if(!killed){proc.kill('SIGKILL');await once(proc,'exit')}
    }
  }
  t.after(async()=>{await stop();await gateway.stop();await db.close();await fs.rm(dir,{recursive:true,force:true})});
  async function request(route,{method='GET',body,token,expect=200,from=origin,headers={}}={}){
    const binary=Buffer.isBuffer(body);
    const response=await fetch(origin+route,{method,headers:{Origin:from,...(token?{Cookie:token}:{}),
      ...(body!==undefined?{'Content-Type':binary?'application/octet-stream':'application/json'}:{}),...headers},
      ...(body!==undefined?{body:binary?body:JSON.stringify(body)}:{})});
    const json=response.headers.get('content-type')?.includes('json')?await response.json():null;
    assert.equal(response.status,expect,JSON.stringify({route,json,logs}));
    return {json,response};
  }
  const create=async (login,nickname,creatorCode)=>{
    const {json,response}=await request('/api/auth/register',{method:'POST',body:{login,nickname,password:pass,confirmation:pass,creatorCode},expect:201});
    const cookie=response.headers.get('set-cookie');
    assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);
    assert(!JSON.stringify(json).includes('$argon2'));
    return {id:json.user.id,user:json.user,codes:json.recoveryCodes,token:cookie.split(';')[0]};
  };
  const login=async (name,password=pass)=>{
    const {json,response}=await request('/api/auth/login',{method:'POST',body:{login:name,password}});
    return {id:json.user.id,user:json.user,token:response.headers.get('set-cookie').split(';')[0]};
  };
  async function connect(user){
    const socket=io(origin,{extraHeaders:{Cookie:user.token,Origin:origin},transports:['websocket'],forceNew:true,reconnection:false});
    sockets.push(socket);
    await Promise.race([once(socket,'connect'),once(socket,'connect_error').then(([error])=>{throw error}),delay(6000,null,{ref:false}).then(()=>{throw new Error('Socket timeout')})]);
    return socket;
  }
  const send=(socket,event,payload)=>new Promise((resolve,reject)=>socket.timeout(7000).emit(event,payload,(error,result)=>{
    if(error)reject(error);
    else if(!result?.ok)reject(new Error(result?.error||event));
    else resolve(result);
  }));

  await start();
  const a=await create('cinema-owner','Создатель',setupCode);
  const b=await create('cinema-guest','Гость');
  const c=await create('cinema-other','Третий');
  assert.equal(a.user.role,'creator');assert.equal(b.user.role,'member');assert.notEqual(a.id,b.id);
  await request('/api/auth/login',{method:'POST',body:{login:'cinema-owner',password:'different password'},expect:401});
  await request('/api/friends/'+b.id,{method:'POST',token:a.token,from:'https://unrelated.example',expect:403});
  const aPhone=await login('cinema-owner');
  assert.equal(a.id,aPhone.id);
  const sessions=(await request('/api/auth/sessions',{token:a.token})).json.sessions;
  assert.equal(sessions.length,2);
  const lookup=(await request('/api/people?q='+b.user.friendCode,{token:a.token})).json.people;
  assert.equal(lookup[0].id,b.id);
  await request('/api/profile',{method:'PATCH',token:b.token,body:{nickname:'Новый ник',bio:'Космический вечер'}});
  const before=(await request('/api/profiles/'+b.id,{token:a.token})).json;
  assert.equal(before.person.nickname,'Новый ник');
  assert.equal(before.person.id,b.id);
  assert.deepEqual(before.personal,{});assert.equal(before.history,null);assert.equal(before.canSeeFriends,false);
  await request('/api/profiles/'+b.id+'/friends',{token:a.token,expect:404});
  await request('/api/dialogs',{method:'POST',token:a.token,body:{userId:b.id},expect:403});
  await request('/api/friends/'+b.id,{method:'POST',token:a.token});
  await request('/api/friends/'+b.id,{method:'POST',token:a.token});
  assert.equal((await request('/api/friends',{token:b.token})).json.people.length,1);
  await request('/api/friends/'+a.id,{method:'PATCH',token:b.token,body:{action:'accept'}});
  assert.equal((await request('/api/friends',{token:b.token})).json.people[0].relationship,'friend');

  const photo=await sharp({create:{width:40,height:40,channels:3,background:'#222'}}).png().toBuffer();
  await request('/api/profile/avatar',{method:'PUT',token:b.token,body:Buffer.from('not image'),expect:400});
  await request('/api/profile/avatar',{method:'PUT',token:b.token,body:photo});
  const first=(await request('/api/avatars/'+b.id,{token:a.token})).response;
  assert.equal((await sharp(Buffer.from(await first.arrayBuffer())).metadata()).format,'webp');
  await request('/api/profile/avatar',{method:'PUT',token:b.token,body:photo});
  assert.equal((await fs.readdir(avatars)).length,1);
  await request('/api/profile/avatar',{method:'DELETE',token:b.token});
  await request('/api/avatars/'+b.id,{token:a.token,expect:404});

  const as=await connect(a),bs=await connect(b),cs=await connect(c);
  let outsiderUpdates=0;
  cs.on('direct-update',()=>outsiderUpdates++);
  const dialog=(await request('/api/dialogs',{method:'POST',token:a.token,body:{userId:b.id}})).json.id;
  assert.equal((await request('/api/dialogs',{method:'POST',token:b.token,body:{userId:a.id}})).json.id,dialog);
  const event=once(bs,'direct-update');
  const body={body:'Привет из космоса ✨',clientId:crypto.randomUUID()};
  const sent=(await request('/api/dialogs/'+dialog+'/messages',{method:'POST',token:a.token,body,expect:201})).json.message;
  assert.equal((await event)[0].conversationId,dialog);
  await request('/api/dialogs/'+dialog+'/messages',{method:'POST',token:a.token,body,expect:201});
  assert.equal((await request('/api/dialogs/'+dialog+'/messages',{token:b.token})).json.messages.length,1);
  await request('/api/dialogs/'+dialog+'/messages',{token:c.token,expect:404});
  assert.equal(outsiderUpdates,0);
  assert.equal((await request('/api/dialogs',{token:b.token})).json.dialogs[0].unread,1);
  await request('/api/dialogs/'+dialog+'/read',{method:'POST',token:b.token,body:{through:sent.id}});
  assert.equal((await request('/api/dialogs',{token:b.token})).json.dialogs[0].unread,0);

  const ownerRoom=await send(as,'join',{});
  const room=ownerRoom.state.room;
  assert.equal(room,legacyRoom);
  assert.equal(ownerRoom.history[0].title,'Старый сеанс');
  const invite=(await request('/api/friends/'+b.id+'/invite',{method:'POST',token:a.token,expect:201})).json.message.invite;
  assert.equal(invite.room,room);
  await send(bs,'join',{room,invite:invite.code});
  const as2=await connect(aPhone);
  await send(as2,'join',{room});
  const roomChat=once(bs,'chat');
  await send(as,'chat',{room,id:crypto.randomBytes(16).toString('hex'),text:'Сообщение кинозала'});
  assert.equal((await roomChat)[0].text,'Сообщение кинозала');
  const poll=once(bs,'room-state');
  await send(as,'poll-create',['Начало','Интерстеллар']);
  const vote=(await poll)[0].poll;
  assert.equal(vote.counts,null);
  await send(bs,'poll-vote',{id:vote.id,index:1});
  const result=once(bs,'room-state');
  await send(as,'poll-finish',{id:vote.id});
  assert.equal((await result)[0].poll.counts[1],1);
  const spin=once(bs,'roulette');
  await send(as,'roulette-spin',[{name:'Начало',poster:'posters/demo.webp'},{name:'Интерстеллар'}]);
  assert.equal((await spin)[0].spin.cards.length,28);

  const mediaState=once(bs,'room-state');
  await send(as,'media',{url:'https://media.example/movie.mp4',title:'Космический фильм',poster:'posters/demo.webp'});
  const mediaId=(await mediaState)[0].mediaId;
  const synced=once(bs,'sync');
  as.emit('sync',{mediaId,time:0,playing:true});
  assert.equal((await synced)[0].playing,true);
  const started=Date.now();
  for(let i=0;i<7;i++){
    const pos=(Date.now()-started)/1000;
    for(const s of [as,as2,bs])s.emit('watch-heartbeat',{mediaId,position:pos,playing:true});
    if(i<6)await delay(2050);
  }
  await delay(400);
  as.emit('sync',{mediaId,time:13,playing:false,ended:true});
  await delay(300);
  const profile=(await request('/api/profiles/'+a.id,{token:a.token})).json;
  assert(profile.personal.seconds>=5 && profile.personal.seconds<=15,JSON.stringify(profile.personal));
  assert.equal(profile.personal.films,1);
  assert(profile.shared[0].seconds>0);
  assert.equal(profile.history[0].movie_title,'Космический фильм');
  assert.equal(profile.history[0].status,'completed');
  assert.equal((await request('/api/profiles/'+a.id,{token:c.token})).json.personalHidden,true);
  const rules={watchTime:false,films:true,sessions:false,shared:false,registration:true,history:false,friends:false,presence:false,hideStats:false};
  await request('/api/profile/privacy',{method:'PATCH',token:a.token,body:rules});
  const filtered=(await request('/api/profiles/'+a.id,{token:c.token})).json;
  assert.deepEqual(filtered.personal,{films:1});
  assert.equal(filtered.history,null);
  assert.equal(filtered.canSeeFriends,false);
  const preview=(await request('/api/profiles/'+a.id+'?view=friend',{token:a.token})).json;
  assert.equal(preview.self,false);assert.deepEqual(preview.personal,filtered.personal);
  await request('/api/profile/privacy',{method:'PATCH',token:a.token,body:{...rules,hideStats:true}});
  const hidden=(await request('/api/profiles/'+a.id,{token:c.token})).json;
  assert.deepEqual(hidden.personal,{});assert.equal(hidden.personalHidden,true);
  assert.equal((await request('/api/export',{token:a.token})).json.history[0].movie_title,'Космический фильм');
  assert(!JSON.stringify((await request('/api/export',{token:a.token})).json).includes('password_hash'));

  await stop();
  await start();
  const aNew=await login('cinema-owner'),bNew=await login('cinema-guest');
  assert.equal(aNew.id,a.id);assert.equal(bNew.id,b.id);assert.equal(bNew.user.nickname,'Новый ник');
  assert.equal((await request('/api/dialogs/'+dialog+'/messages',{token:bNew.token})).json.messages[0].body,body.body);
  const guestFirst=await connect(bNew);
  const recovered=await send(guestFirst,'join',{room});
  assert.equal(recovered.isHost,false);
  assert.equal(recovered.state.messages[0].text,'Сообщение кинозала');
  const ownerNew=await connect(aNew);
  assert.equal((await send(ownerNew,'join',{})).state.room,room);
  await request('/api/friends/'+b.id,{method:'DELETE',token:aNew.token});
  const afterRemoval=(await request('/api/dialogs/'+dialog+'/messages',{token:bNew.token})).json;
  assert.equal(afterRemoval.canSend,false);
  assert.equal(afterRemoval.messages[0].body,body.body);
  const revoke=(await request('/api/auth/sessions',{token:aNew.token})).json.sessions.find(s=>!s.current);
  await request('/api/auth/sessions/'+revoke.id,{method:'DELETE',token:aNew.token});
  const reset='New recovery test password 679!';
  await request('/api/auth/recover',{method:'POST',body:{login:'cinema-guest',code:b.codes[0],password:reset,confirmation:reset}});
  await request('/api/auth/recover',{method:'POST',body:{login:'cinema-guest',code:b.codes[0],password:reset,confirmation:reset},expect:403});
  assert.equal((await login('cinema-guest',reset)).id,b.id);
  const hashes=(await db.query('SELECT password_hash FROM users')).rows;
  assert(hashes.every(row=>row.password_hash.startsWith('$argon2id$')&&!row.password_hash.includes(pass)));
});
