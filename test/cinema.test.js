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
import argon2 from 'argon2';
import sharp from 'sharp';
import {advanceEvidence} from '../lib/watch.js';
import {parseMedia} from '../media.js';
import {catalogPoster,movieKey} from '../lib/watch-media.js';

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
    proc=spawn(process.execPath,['--import','./test/avatar-storage-fixture.js','--import','./test/watch-cover-fixture.js','server.js'],{env:{
      ...process.env,NODE_ENV:'test',PORT:String(port),APP_ORIGIN:origin,DATABASE_URL:database,
      CINEMA_CREATOR_SETUP_CODE:setupCode,UPSTASH_REDIS_REST_URL:'',UPSTASH_REDIS_REST_TOKEN:'',
      CINEMA_ADMIN_LOGIN:'',CINEMA_ADMIN_SECRET:legacySecret,CINEMA_DATA_DIR:legacy,CINEMA_LEGACY_ROOM_ID:'',
      SUPABASE_URL:'https://cinema-avatar-fixture.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_fixture-only',
      TEST_AVATAR_DIR:avatars,TMDB_READ_TOKEN:'tmdb-test-only',VK_VIDEO_READ_TOKEN:'vk-test-only'
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
  async function connect(user,historyProfile){
    const socket=io(origin,{auth:{historyProfile},extraHeaders:{Cookie:user.token,Origin:origin},transports:['websocket'],forceNew:true,reconnection:false});
    sockets.push(socket);
    await Promise.race([once(socket,'connect'),once(socket,'connect_error').then(([error])=>{throw error}),delay(6000,null,{ref:false}).then(()=>{throw new Error('Socket timeout')})]);
    return socket;
  }
  const send=(socket,event,payload)=>new Promise((resolve,reject)=>socket.timeout(7000).emit(event,payload,(error,result)=>{
    if(error)reject(error);
    else if(!result?.ok)reject(new Error(result?.error||event));
    else resolve(result);
  }));

  const previousPrivacy={watchTime:false,films:false,sessions:false,shared:false,registration:false,
    history:false,friends:false,presence:false,hideStats:false};
  await db.exec(await fs.readFile(new URL('../migrations/001_accounts.sql',import.meta.url),'utf8'));
  await db.exec(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO schema_migrations(name) VALUES ('001_accounts.sql')`);
  const legacyHash=await argon2.hash(pass,{type:argon2.argon2id});
  const priorOwner=crypto.randomUUID(),priorPartner=crypto.randomUUID(),priorPrivate=crypto.randomUUID();
  const oldRoom=crypto.randomBytes(16).toString('hex');
  const oldWatch=crypto.randomUUID(),otherWatch=crypto.randomUUID();
  for(const [id,name] of [[priorOwner,'remedium_cavus'],[priorPartner,'stanislav'],[priorPrivate,'legacy-private']]){
    await db.query(`INSERT INTO users(id,login,nickname,password_hash,friend_code) VALUES($1,$2,$2,$3,$4)`,
      [id,name,legacyHash,crypto.randomBytes(6).toString('hex')]);
  }
  await db.query(`INSERT INTO profile_privacy(user_id,settings,updated_at)
    SELECT id,$1,created_at+CASE WHEN id=$2 THEN interval '1 minute' ELSE interval '0' END FROM users`,
    [JSON.stringify(previousPrivacy),priorPrivate]);
  await db.query(`INSERT INTO cinema_rooms(id,owner_id,state) VALUES($1,$2,$3)`,
    [oldRoom,priorOwner,JSON.stringify({messages:[{text:'Старый чат зала'}],letters:[{id:'old-letter'}]})]);
  for(const [id,partner,slot] of [[oldWatch,priorPartner,320000000],[otherWatch,priorPrivate,320000001]]){
    await db.query(`INSERT INTO watch_sessions(id,room_id,movie_id,movie_title,media_type,started_at,updated_at,status)
      VALUES($1::uuid,$2,$1::uuid::text,'Старый просмотр','video',to_timestamp($3::bigint*5),now(),'completed')`,[id,oldRoom,slot]);
    await db.query(`INSERT INTO watch_participants(watch_session_id,user_id,credited_seconds)
      VALUES($1,$2,5),($1,$3,5)`,[id,priorOwner,partner]);
    await db.query(`INSERT INTO shared_watch_intervals(watch_session_id,user_a_id,user_b_id,slot)
      VALUES($1,least($2::uuid,$3::uuid),greatest($2::uuid,$3::uuid),$4)`,[id,priorOwner,partner,slot]);
  }

  // The old release allowed two participants to set different names and covers.
  await db.exec(await fs.readFile(new URL('../migrations/006_personal_watch_history.sql',import.meta.url),'utf8'));
  await db.query(`UPDATE watch_participants SET history_title=$3
    WHERE watch_session_id=$1 AND user_id=$2`,[oldWatch,priorOwner,'Название от владельца']);
  await db.query(`UPDATE watch_participants SET history_title='Другое название',
    history_cover_set=true,history_poster_url='posters/interstellar-157336.webp'
    WHERE watch_session_id=$1 AND user_id=$2`,[oldWatch,priorPartner]);

  await start();
  for (const [file, type] of Object.entries({'auth.css':'text/css','moon.webp':'image/webp','clouds.webp':'image/webp','water.webp':'image/webp'})) {
    const {response}=await request('/assets/auth/'+file);
    assert.equal(response.headers.get('content-type').split(';')[0],type);
    assert((await response.arrayBuffer()).byteLength>0);
  }
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
  assert.equal(before.theme,'none');
  await request('/api/profile/theme',{method:'PATCH',body:{theme:'hello-kitty-pink'},expect:401});
  await request('/api/profile/theme',{method:'PATCH',token:b.token,body:{theme:'other'},expect:400});
  await request('/api/profile/theme',{method:'PATCH',token:b.token,body:{theme:'hello-kitty-pink'},from:'https://unrelated.example',expect:403});
  await request('/api/profiles/'+a.id+'/theme',{method:'PATCH',token:b.token,body:{theme:'hello-kitty-pink'},expect:404});
  for(const theme of ['cosmos','sakura','clouds','lavender','cyberpunk','icy-night','nefertiti','sakura-night','none']){
    assert.deepEqual((await request('/api/profile/theme',{method:'PATCH',token:b.token,body:{theme}})).json,{theme});
    assert.equal((await request('/api/profiles/'+b.id,{token:a.token})).json.theme,theme);
  }
  const appearance=await request('/api/profile/theme',{method:'PATCH',token:b.token,body:{theme:'hello-kitty-pink'}});
  assert.deepEqual(appearance.json,{theme:'hello-kitty-pink'});
  assert.equal((await request('/api/profiles/'+a.id,{token:b.token})).json.theme,'none');
  assert.equal(before.personal.seconds,0);
  assert.deepEqual(before.history,[]);assert.equal(before.canSeeFriends,true);
  assert.equal(before.friendCount,0);assert.deepEqual(before.shared,[]);assert.equal(before.sharedTotal.sessions,0);
  assert(before.person.registeredAt);assert.equal(before.person.online,false);
  assert.deepEqual((await request('/api/profiles/'+b.id+'/friends',{token:a.token})).json.friends,[]);
  await request('/api/dialogs',{method:'POST',token:a.token,body:{userId:b.id},expect:403});
  await request('/api/friends/'+b.id,{method:'POST',token:a.token});
  await request('/api/friends/'+b.id,{method:'POST',token:a.token});
  assert.equal((await request('/api/friends',{token:b.token})).json.people.length,1);
  assert.equal((await request('/api/profiles/'+b.id,{token:a.token})).json.friendCount,0);
  await request('/api/friends/'+a.id,{method:'PATCH',token:b.token,body:{action:'accept'}});
  assert.equal((await request('/api/friends',{token:b.token})).json.people[0].relationship,'friend');
  assert.equal((await request('/api/profiles/'+b.id,{token:a.token})).json.friendCount,1);
  assert.equal((await request('/api/profiles/'+b.id,{token:a.token})).json.theme,'hello-kitty-pink');

  const migrated=(await request('/api/profiles/'+priorOwner,{token:a.token})).json;
  assert.equal(migrated.personal.seconds,10);assert.equal(migrated.personal.shared_count,1);
  assert.equal(migrated.sharedTotal.sessions,1);assert.deepEqual(migrated.shared,[]);
  assert(migrated.person.registeredAt);
  const privateProfile=(await request('/api/profiles/'+priorPrivate,{token:a.token})).json;
  assert.deepEqual(privateProfile.personal,{});assert.equal(privateProfile.sharedTotal,null);
  assert.equal(privateProfile.history,null);assert.equal(privateProfile.canSeeFriends,false);
  const ownProfile=await login('remedium_cavus');
  const partnerProfile=await login('stanislav');
  const ownOverview=(await request('/api/profiles/'+priorOwner,{token:ownProfile.token})).json;
  assert.equal(ownOverview.theme,'none');
  assert.deepEqual(ownOverview.shared.map(item=>item.person.id),[priorPrivate]);
  assert.deepEqual(ownOverview.history.find(item=>item.id===oldWatch).participants,[{id:priorPartner,nickname:'stanislav'}]);
  assert.deepEqual(ownOverview.history.find(item=>item.id===otherWatch).participants,[]);
  assert.deepEqual((await request('/api/shared/'+priorPartner,{token:ownProfile.token})).json.history,[]);
  for(const [person,token] of [[priorOwner,ownProfile.token],[priorPartner,partnerProfile.token]]){
    const entry=(await request('/api/profiles/'+person,{token})).json.history.find(item=>item.id===oldWatch);
    assert.equal(entry.movie_title,'Название от владельца');
    assert.equal(entry.poster_key,'posters/interstellar-157336.webp');
    assert(entry.poster_revision);
  }
  assert.equal((await request('/api/shared/'+priorOwner,{token:partnerProfile.token})).json.history[0].id,oldWatch);
  const {rows:[cleanRoom]}=await db.query('SELECT state FROM cinema_rooms WHERE id=$1',[oldRoom]);
  assert.deepEqual(cleanRoom.state,{letters:[{id:'old-letter'}]});
  await db.query(`UPDATE cinema_rooms SET state=state||'{"messages":[{"text":"Старая запись"}]}'::jsonb WHERE id=$1`,[oldRoom]);
  assert.equal((await db.query('SELECT state FROM cinema_rooms WHERE id=$1',[oldRoom])).rows[0].state.messages,undefined);

  const archived=[
    {url:'https://m.vkvideo.ru/video-100_200',title:'Интерстеллар',expected:'posters/interstellar-157336.webp'},
    {url:'https://youtu.be/LegacySrc01',title:'YouTube',expected:catalogPoster('Выход 8')},
    {url:'https://vkvideo.ru/video-987_654',title:'VK Видео',expected:'https://images.example.org/vk-thumbnail.jpg'},
    {url:'https://vkvideo.ru/video-101_201',title:'VK Видео',expected:null},
  ];
  await db.query('UPDATE cinema_rooms SET history=$2 WHERE id=$1',[oldRoom,JSON.stringify(archived)]);
  for(const entry of archived){
    const source=parseMedia(entry.url);
    entry.id=crypto.randomUUID();
    await db.query(`INSERT INTO watch_sessions(id,room_id,movie_id,movie_title,media_type,
      started_at,updated_at,status) VALUES($1,$2,$3,$4,$5,now(),now(),'interrupted')`,
      [entry.id,oldRoom,movieKey(source),source.type==='vk'?'VK Видео':'YouTube',source.type]);
    await db.query(`INSERT INTO watch_participants(watch_session_id,user_id,credited_seconds) VALUES($1,$2,5)`,
      [entry.id,priorOwner]);
  }
  const restored=(await request('/api/profiles/'+priorOwner,{token:ownProfile.token})).json.history;
  for(const entry of archived){
    const watch=restored.find(item=>item.id===entry.id);
    assert.equal(watch.poster_key,entry.expected);
    assert.equal(watch.status,'interrupted');
    assert.equal(watch.can_edit_cover,true);
    assert.deepEqual(watch.participants,[]);
  }
  assert.equal(restored.find(item=>item.id===archived[0].id).movie_title,'Интерстеллар');
  assert.equal(restored.find(item=>item.id===archived[1].id).movie_title,'Выход 8');
  assert.equal(restored.find(item=>item.id===archived[3].id).movie_title,null);
  const legacyCover='/api/watch-history/'+archived[3].id+'/cover';
  const legacyPoster='posters/interstellar-157336.webp';
  await request(legacyCover,{token:ownProfile.token,method:'PATCH',body:{poster:legacyPoster,revision:null}});
  const restoredEdit=(await request('/api/profiles/'+priorOwner,{token:ownProfile.token})).json.history;
  assert.equal(restoredEdit.find(item=>item.id===archived[3].id).poster_key,legacyPoster);
  const restoredPoster=restoredEdit.find(item=>item.id===archived[3].id);
  await request(legacyCover,{token:ownProfile.token,method:'PATCH',body:{revision:restoredPoster.poster_revision,poster:''}});
  const clearedCover=(await request('/api/profiles/'+priorOwner,{token:ownProfile.token})).json.history.find(item=>item.id===archived[3].id);
  assert.equal(clearedCover.poster_key,null);
  assert.equal(clearedCover.custom_poster_url,null);

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
  const guestRoom=await send(bs,'join',{room,invite:invite.code});
  const firstChatId=guestRoom.state.chatId;
  const as2=await connect(aPhone);
  await send(as2,'join',{room});
  const roomChat=once(bs,'chat');
  const outgoing={room,chatId:firstChatId,id:crypto.randomBytes(16).toString('hex'),text:'Сообщение кинозала'};
  await send(as,'chat',outgoing);
  const [received]=await roomChat;
  assert.equal(received.text,outgoing.text);
  await send(as,'chat',outgoing);
  assert.equal((await send(as2,'join',{room})).state.messages.length,1);
  const reaction=once(as,'reaction-update');
  await send(bs,'react',{id:received.id,emoji:'❤️'});
  assert.equal((await reaction)[0].chatId,firstChatId);
  const secondaryDevice=await connect(aPhone);
  await send(secondaryDevice,'join',{room});
  const otherDeviceLeft=once(as,'room-state');
  secondaryDevice.disconnect();
  assert.equal((await otherDeviceLeft)[0].chatId,firstChatId);
  const guestLeft=once(as,'room-state');
  const separate=await send(bs,'join',{});
  assert.notEqual(separate.state.room,room);
  assert.deepEqual(separate.state.messages,[]);
  const [remaining]=await guestLeft;
  assert.equal(remaining.chatId,firstChatId);
  const returned=await send(bs,'join',{room});
  assert.equal(returned.state.messages.length,1);
  assert.equal(returned.state.messages[0].id,received.id);
  assert.equal(returned.state.messages[0].reactions["❤️"].length,1);
  await send(as,'chat',{...outgoing,chatId:returned.state.chatId});
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
  const [loaded]=await mediaState;
  const mediaId=loaded.mediaId;
  assert.notEqual(loaded.chatId,returned.state.chatId);assert.deepEqual(loaded.messages,[]);
  await assert.rejects(send(as,'chat',{...outgoing,chatId:returned.state.chatId}),/Чат зала обновился/);
  await send(as,'chat',{...outgoing,chatId:loaded.chatId});
  const synced=once(bs,'sync');
  as.emit('sync',{mediaId,time:0,duration:13,playing:true});
  assert.equal((await synced)[0].playing,true);
  const started=Date.now();
  for(let i=0;i<7;i++){
    const pos=(Date.now()-started)/1000;
    if(i===3)as.emit('sync',{mediaId,time:pos,duration:13,playing:true});
    for(const s of [as,as2,bs])s.emit('watch-heartbeat',{mediaId,position:pos,playing:true});
    if(i<6)await delay(2050);
  }
  await delay(400);
  as.emit('sync',{mediaId,time:13,duration:13,playing:false,ended:true});
  await delay(300);
  const profile=(await request('/api/profiles/'+a.id,{token:a.token})).json;
  assert(profile.personal.seconds>=5 && profile.personal.seconds<=15,JSON.stringify(profile.personal));
  assert.equal(profile.personal.films,1);
  assert(profile.shared[0].seconds>0);
  assert.equal(profile.history[0].movie_title,'Космический фильм');
  assert.equal(profile.history[0].status,'completed');
  const visit=profile.history[0];
  assert.deepEqual(visit.participants,[{id:b.id,nickname:'Новый ник'}]);
  assert.equal(visit.poster_key,'posters/demo.webp');
  const coverRoute='/api/watch-history/'+visit.id+'/cover';
  const searchRoute='/api/watch-history/'+visit.id+'/cover-search?title=';
  const title=encodeURIComponent('Проверяемый фильм');
  await request(searchRoute+title,{token:b.token});
  await request(searchRoute+title,{token:c.token,expect:404});
  const localResult=(await request(searchRoute+encodeURIComponent('Интерстеллар'),{token:a.token})).json;
  assert.equal(localResult.films[0].poster_key,'posters/interstellar-157336.webp');
  const choices=(await request(searchRoute+title,{token:a.token})).json;
  assert.deepEqual(choices.films,[{id:42,title:'Проверяемый фильм',release_year:2019,poster_key:'https://image.tmdb.org/t/p/w500/fixture.jpg'}]);
  assert.equal((await request('/api/profiles/'+a.id,{token:a.token})).json.history[0].poster_key,visit.poster_key);
  const profileVisitor=await connect(c,b.id);
  const notices=Promise.all([once(bs,'watch-history-updated'),once(profileVisitor,'watch-history-updated')]);
  await request(coverRoute,{token:a.token,method:'PATCH',body:{filmId:42,revision:null}});
  for(const [notice] of await notices)assert.deepEqual(notice,{id:visit.id});
  profileVisitor.disconnect();
  const chosen=(await request('/api/profiles/'+a.id,{token:a.token})).json.history[0];
  assert.equal(chosen.release_year,2019);
  assert.equal(chosen.poster_key,choices.films[0].poster_key);
  assert.equal(chosen.movie_title,'Проверяемый фильм');
  await request(coverRoute,{token:a.token,method:'PATCH',body:{filmId:42,revision:null},expect:409});
  const manual='https://images.example.org/manual-cover.webp';
  await request(coverRoute,{token:b.token,method:'PATCH',body:{poster:manual,revision:chosen.poster_revision}});
  await request(coverRoute,{token:a.token,method:'PATCH',body:{title:'Устаревшая правка',revision:chosen.poster_revision},expect:409});
  await request(coverRoute,{token:c.token,method:'PATCH',body:{title:'Посторонний',revision:null},expect:404});
  await request(searchRoute+title,{token:a.token});
  const saved=(await request('/api/profiles/'+a.id,{token:a.token})).json.history[0];
  assert.equal(saved.poster_key,manual);assert.equal(saved.release_year,2019);
  const guestHistory=(await request('/api/profiles/'+b.id,{token:b.token})).json.history[0];
  assert.equal(guestHistory.poster_key,manual);
  assert.equal(guestHistory.poster_revision,saved.poster_revision);
  assert.equal(guestHistory.movie_title,'Проверяемый фильм');
  assert.equal((await db.query('SELECT movie_title,poster_key FROM watch_sessions WHERE id=$1',[visit.id])).rows[0].poster_key,visit.poster_key);

  await request('/api/profile',{method:'PATCH',token:b.token,body:{nickname:'Друг после переименования',bio:''}});
  assert.equal((await request('/api/profiles/'+b.id,{token:a.token})).json.theme,'hello-kitty-pink');
  assert.deepEqual((await request('/api/profiles/'+a.id,{token:a.token})).json.history[0].participants,
    [{id:b.id,nickname:'Друг после переименования'}]);
  await request('/api/profile',{method:'PATCH',token:b.token,body:{nickname:'Новый ник',bio:'Космический вечер'}});
  const visible=(await request('/api/profiles/'+a.id,{token:c.token})).json;
  assert.equal(visible.personalHidden,false);assert.equal(visible.friendCount,1);
  assert.equal(visible.sharedTotal.sessions,1);assert.deepEqual(visible.shared,[]);
  assert.equal(visible.history[0].movie_title,'Проверяемый фильм');
  assert.equal(Object.hasOwn(visible.history[0],'participants'),false);
  await db.query('INSERT INTO watch_participants(watch_session_id,user_id,credited_seconds) VALUES ($1,$2,5)',[visit.id,c.id]);
  const withoutOverlap=(await request('/api/profiles/'+c.id,{token:c.token})).json.history[0];
  assert.deepEqual(withoutOverlap.participants,[]);
  assert.equal(withoutOverlap.poster_key,manual);
  await db.query(`INSERT INTO shared_watch_intervals(watch_session_id,user_a_id,user_b_id,slot)
    SELECT DISTINCT ON (slot) $1,least($2::uuid,$3::uuid),greatest($2::uuid,$3::uuid),slot
    FROM shared_watch_intervals WHERE watch_session_id=$1 ORDER BY slot LIMIT 1`,[visit.id,a.id,c.id]);
  const several=(await request('/api/profiles/'+a.id,{token:a.token})).json.history[0];
  assert.deepEqual(new Set(several.participants.map(person=>person.id)),new Set([b.id,c.id]));
  const cSettings=(await request('/api/profiles/'+c.id,{token:c.token})).json.privacy;
  await request('/api/profile/privacy',{method:'PATCH',token:c.token,body:{...cSettings,shared:false}});
  assert.deepEqual((await request('/api/profiles/'+a.id,{token:a.token})).json.history[0].participants,
    [{id:b.id,nickname:'Новый ник'}]);
  await request('/api/profile/privacy',{method:'PATCH',token:c.token,body:cSettings});

  const rules={watchTime:false,films:true,sessions:false,shared:false,registration:true,history:false,friends:false,presence:false,hideStats:false};
  await request('/api/profile/privacy',{method:'PATCH',token:a.token,body:rules});
  const filtered=(await request('/api/profiles/'+a.id,{token:c.token})).json;
  assert.deepEqual(filtered.personal,{films:1});
  assert.equal(filtered.history,null);
  assert.equal(filtered.canSeeFriends,false);
  assert.equal(filtered.friendCount,1);assert.equal(filtered.sharedTotal,null);
  const preview=(await request('/api/profiles/'+a.id+'?view=friend',{token:a.token})).json;
  assert.equal(preview.self,false);assert.deepEqual(preview.personal,filtered.personal);
  await request('/api/profile/privacy',{method:'PATCH',token:a.token,body:{...rules,hideStats:true}});
  const hidden=(await request('/api/profiles/'+a.id,{token:c.token})).json;
  assert.deepEqual(hidden.personal,{});assert.equal(hidden.personalHidden,true);
  assert.equal(hidden.profileHidden,false);
  await request('/api/friends/'+c.id,{method:'POST',token:a.token});
  await request('/api/friends/'+a.id,{method:'PATCH',token:c.token,body:{action:'accept'}});
  await request('/api/friends/'+c.id,{method:'POST',token:b.token});
  await request('/api/friends/'+b.id,{method:'PATCH',token:c.token,body:{action:'accept'}});
  const allowed={...rules,history:true,friends:true,shared:true,hideProfile:false};
  await request('/api/profile/theme',{method:'PATCH',token:a.token,body:{theme:'hello-kitty-pink'}});
  await request('/api/profile/privacy',{method:'PATCH',token:a.token,body:allowed});
  const open=(await request('/api/profiles/'+a.id,{token:b.token})).json;
  assert.deepEqual(open.mutualFriends.map(friend=>friend.id),[c.id]);
  assert.deepEqual((await request('/api/profiles/'+a.id+'/friends',{token:b.token})).json.friends.map(friend=>friend.id),[c.id]);
  await request('/api/profile/privacy',{method:'PATCH',token:a.token,body:{...allowed,hideProfile:true}});
  await request('/api/profile/privacy',{method:'PATCH',token:a.token,body:rules});
  const outsider=await login('legacy-private');
  for(const [token,relationship] of [[b.token,'friend'],[outsider.token,'none']]){
    const privateView=(await request('/api/profiles/'+a.id+'?offset=3',{token})).json;
    assert.equal(privateView.profileHidden,true);
    assert.equal(privateView.theme,'hello-kitty-pink');
    assert.equal(privateView.relationship,relationship);
    assert.deepEqual(Object.keys(privateView.person).sort(),['avatar','id','login','nickname']);
    for(const key of ['personal','shared','sharedTotal','history','mutualFriends','friendCount','friendCode','privacy'])
      assert.equal(Object.hasOwn(privateView,key),false,key);
    await request('/api/profiles/'+a.id+'/friends',{token,expect:404});
    await request('/api/shared/'+a.id,{token,expect:404});
  }
  const hiddenPreview=(await request('/api/profiles/'+a.id+'?view=friend&friend='+b.id,{token:a.token})).json;
  assert.equal(hiddenPreview.profileHidden,true);
  await request('/api/profiles/'+a.id+'/friends?view=friend&friend='+b.id,{token:a.token,expect:404});
  const owner=(await request('/api/profiles/'+a.id,{token:a.token})).json;
  assert.equal(owner.privacy.hideProfile,true);
  assert.equal(owner.history[0].movie_title,'Проверяемый фильм');
  assert.equal((await request('/api/profile/shared/'+a.id,{token:b.token})).json.history[0].movie_title,'Проверяемый фильм');
  assert.equal((await request('/api/profile/shared/'+a.id,{token:b.token})).json.history[0].poster_key,manual);
  assert.equal((await request('/api/profile/shared/'+b.id,{token:a.token})).json.history[0].movie_title,'Проверяемый фильм');
  await request('/api/profile/privacy',{method:'PATCH',token:a.token,body:allowed});
  const reopened=(await request('/api/profiles/'+a.id,{token:b.token})).json;
  assert.equal(reopened.profileHidden,false);
  assert.equal(reopened.history[0].movie_title,'Проверяемый фильм');
  assert.equal((await request('/api/export',{token:a.token})).json.history[0].movie_title,'Космический фильм');
  assert(!JSON.stringify((await request('/api/export',{token:a.token})).json).includes('password_hash'));

  const visitor=await connect(c);
  const visitorRoom=await send(visitor,'join',{});
  await send(visitor,'media',{url:'https://youtu.be/abcdefghijk'});
  const {state:{mediaId:visitorMovieId}}=await send(visitor,'join',{});
  assert(visitorMovieId);
  const visitorInvite=await send(visitor,'invite',{});
  const creatorGuest=await connect(a);
  await send(creatorGuest,'join',{room:visitorRoom.state.room,invite:visitorInvite.invite});
  await assert.rejects(send(creatorGuest,'watch-finish',{mediaId:visitorMovieId}),/только владелец/);
  await assert.rejects(send(visitor,'watch-finish',{mediaId:'x'}),/Фильм уже сменился/);
  await send(visitor,'watch-finish',{mediaId:visitorMovieId});

  const nextMovie=once(bs,'room-state');
  await send(as,'media',{url:'https://media.example/other.mp4',title:'Интерстеллар'});
  const [next]=await nextMovie;
  const nextId=next.mediaId;
  await assert.rejects(send(bs,'watch-finish',{mediaId:nextId}),/только владелец/);
  await assert.rejects(send(as,'watch-finish',{mediaId}),/Фильм уже сменился/);
  as.emit('sync',{mediaId:nextId,time:0,duration:600,playing:true});
  const second=Date.now();
  for(let i=0;i<7;i++){
    const position=(Date.now()-second)/1000;
    for(const s of [as,bs])s.emit('watch-heartbeat',{mediaId:nextId,position,playing:true});
    if(i<6)await delay(2030);
  }
  as.emit('sync',{mediaId:nextId,time:12,duration:600,playing:false,ended:true});
  await until(async()=>{
    const record=(await request('/api/profiles/'+a.id,{token:a.token})).json.history[0];
    return record?.movie_title==='Интерстеллар';
  });
  const running=(await request('/api/profiles/'+a.id,{token:a.token})).json.history[0];
  assert.equal(running.status,'running');assert.equal(running.ended_at,null);
  const finished=once(bs,'room-state');
  await Promise.all([send(as,'watch-finish',{mediaId:nextId}),send(as2,'watch-finish',{mediaId:nextId})]);
  assert.equal((await finished)[0].media,null);
  const completedGuest=(await request('/api/profiles/'+b.id,{token:b.token})).json.history[0];
  assert.equal(completedGuest.id,running.id);
  assert.equal(completedGuest.status,'completed');
  assert(completedGuest.ended_at);
  assert.equal(completedGuest.poster_key,'posters/interstellar-157336.webp');
  assert.equal((await db.query('SELECT count(*) AS total FROM watch_sessions WHERE room_id=$1',[room])).rows[0].total,2);

  const repeatedId=crypto.randomUUID();
  const repeatedOriginal='posters/repeated-source.webp';
  await db.query(`INSERT INTO watch_sessions(id,room_id,movie_id,movie_title,media_type,poster_key,started_at,updated_at,ended_at,status)
    SELECT $1,room_id,movie_id,'Исходное название повтора',media_type,$2,started_at+interval '1 second',
      updated_at,ended_at,status FROM watch_sessions WHERE id=$3`,[repeatedId,repeatedOriginal,visit.id]);
  await db.query('INSERT INTO watch_participants(watch_session_id,user_id,credited_seconds) VALUES($1,$2,5)',[repeatedId,a.id]);
  const previousCover='https://images.example.org/legacy-room.webp';
  await db.query(`INSERT INTO watch_room_movie_details(room_id,movie_id,poster_url,title,revision)
    SELECT room_id,movie_id,$1,'Сохранённое старое название',$2 FROM watch_sessions WHERE id=$3`,
  [previousCover,crypto.randomUUID(),visit.id]);
  const loadProfile=async (account,token=account.token)=>(await request('/api/profiles/'+account.id,{token})).json;
  const loadRepeat=async ()=>(await loadProfile(a)).history.find(item=>item.id===repeatedId);
  assert.equal((await loadRepeat()).movie_title,'Сохранённое старое название');
  assert.equal((await loadRepeat()).custom_poster_url,previousCover);
  const repeatCoverRoute='/api/watch-history/'+repeatedId+'/cover';
  const repeatedTitle='Моё название повторного просмотра';
  await request(repeatCoverRoute,{method:'PATCH',token:a.token,body:{revision:null,title:repeatedTitle}});
  assert.equal((await loadRepeat()).poster_key,previousCover);
  const repeatCover='https://images.example.org/other-view.webp';
  await request(repeatCoverRoute,{method:'PATCH',token:a.token,body:{revision:(await loadRepeat()).poster_revision,poster:repeatCover}});
  assert.equal((await loadRepeat()).poster_key,repeatCover);
  assert.equal((await loadProfile(a)).history.find(item=>item.id===visit.id).poster_key,manual);
  await request(repeatCoverRoute,{method:'PATCH',token:a.token,body:{revision:(await loadRepeat()).poster_revision,poster:''}});
  const resetCover=await loadRepeat();
  assert.equal(resetCover.movie_title,repeatedTitle);
  assert.equal(resetCover.poster_key,repeatedOriginal);
  assert.equal(resetCover.custom_poster_url,null);

  await request('/api/profile/privacy',{method:'PATCH',token:a.token,body:{...allowed,watchTime:true,sessions:true}});
  const previousPersonal=(await loadProfile(a)).personal;
  const previousGuest=(await loadProfile(b)).personal;
  const deleteRoute='/api/watch-history/'+running.id;
  await request(deleteRoute,{method:'DELETE',token:c.token,expect:404});
  await Promise.all([1,2].map(()=>request(deleteRoute,{method:'DELETE',token:a.token})));
  const afterDelete=await loadProfile(a);
  assert.equal(afterDelete.personal.seconds,previousPersonal.seconds-running.credited_seconds);
  assert.equal(afterDelete.personal.sessions,previousPersonal.sessions-1);
  assert.equal(afterDelete.personal.films,previousPersonal.films-1);
  assert(!afterDelete.history.some(item=>item.id===running.id));
  assert.equal((await loadProfile(b)).history.find(item=>item.id===running.id).status,'completed');
  assert.deepEqual((await loadProfile(b)).personal,previousGuest);
  await request(deleteRoute+'/cover',{method:'PATCH',token:a.token,body:{poster:manual,revision:null},expect:404});
  assert(!(await request('/api/export',{token:a.token})).json.history.some(item=>item.id===running.id));

  const beforeRestart=await send(as,'join',{room});
  const restartChat=beforeRestart.state.chatId;
  const retained=once(bs,'chat');
  await send(as,'chat',{room,chatId:restartChat,id:crypto.randomBytes(16).toString('hex'),text:'До перезапуска'});
  const [beforeMessage]=await retained;
  await send(bs,'react',{id:beforeMessage.id,emoji:'🔥'});
  await request('/api/profile/theme',{method:'PATCH',token:b.token,body:{theme:'sakura-night'}});
  await stop();
  await start();
  const aNew=await login('cinema-owner'),bNew=await login('cinema-guest');
  assert.equal(aNew.id,a.id);assert.equal(bNew.id,b.id);assert.equal(bNew.user.nickname,'Новый ник');
  assert.equal((await request('/api/profiles/'+b.id,{token:aNew.token})).json.theme,'sakura-night');
  await request('/api/profile/theme',{method:'PATCH',token:bNew.token,body:{theme:'none'}});
  assert.equal((await request('/api/profiles/'+b.id,{token:aNew.token})).json.theme,'none');
  assert.equal((await request('/api/profiles/'+a.id,{token:bNew.token})).json.theme,'hello-kitty-pink');
  assert.equal((await loadProfile(bNew)).history.find(item=>item.id===visit.id).poster_key,manual);
  const savedHistory=(await request('/api/profiles/'+a.id,{token:aNew.token})).json.history;
  assert.equal(savedHistory.find(item=>item.id===visit.id).poster_key,manual);
  assert.equal(savedHistory.find(item=>item.id===running.id),undefined);
  assert.equal(savedHistory.find(item=>item.id===repeatedId).poster_key,repeatedOriginal);
  assert.equal(savedHistory.find(item=>item.id===repeatedId).movie_title,repeatedTitle);
  assert.equal((await loadProfile(bNew)).history.find(item=>item.id===running.id).status,'completed');
  assert.equal((await request('/api/dialogs/'+dialog+'/messages',{token:bNew.token})).json.messages[0].body,body.body);
  const guestFirst=await connect(bNew);
  const recovered=await send(guestFirst,'join',{room});
  assert.equal(recovered.isHost,false);
  assert.notEqual(recovered.state.chatId,loaded.chatId);
  assert.equal(recovered.state.chatId,restartChat);
  assert.equal(recovered.state.messages.at(-1).id,beforeMessage.id);
  assert.equal(recovered.state.messages.at(-1).reactions['🔥'].length,1);
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
