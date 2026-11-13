import crypto from 'node:crypto';
import {query,transaction} from './db.js';
import {requireUser} from './auth.js';
import {ensure,limiter,pair,text,uuid} from './http.js';
import {person,relationship} from './profiles.js';
import {newInvite} from './rooms.js';

const rate=limiter(28,60000,req=>req.user.id);
const numeric=value=>typeof value==='string' && /^\d{1,18}$/.test(value);
const unreadMessages=`d.conversation_id=m.conversation_id AND d.id>m.last_read_id
  AND d.sender_id<>m.user_id AND d.deleted_at IS NULL`;
const publicMessage=row=>({
  id:String(row.id),senderId:row.sender_id,body:row.deleted_at?'':row.body,createdAt:row.created_at,
  deleted:!!row.deleted_at,invite:row.room_id&&!row.deleted_at?{room:row.room_id,code:row.invite_code}:null
});

async function membership(id,user,db={query},lock=false) {
  ensure(uuid(id),404,'Диалог не найден.');
  const {rows:[row]}=await db.query(`
    SELECT c.*,m.last_read_id, o.last_read_id AS other_read,
      CASE WHEN c.user_a_id=$2 THEN c.user_b_id ELSE c.user_a_id END AS other_id
    FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id AND m.user_id=$2
    JOIN conversation_members o ON o.conversation_id=c.id AND o.user_id<>$2
    WHERE c.id=$1`+(lock?' FOR UPDATE OF c':''),[id,user]);
  ensure(row,404,'Диалог не найден.');
  return row;
}

async function openDialog(a,b) {
  ensure(uuid(b)&&b!==a,400,'Выбери другого пользователя.');
  return transaction(async client=>{
    const ids=pair(a,b);
    const {rows:[prior]}=await client.query('SELECT id FROM conversations WHERE user_a_id=$1 AND user_b_id=$2',ids);
    if(prior) return prior.id;
    ensure((await relationship(a,b,client,true))?.status==='accepted',403,'Личные сообщения доступны после принятия заявки в друзья.');
    const id=crypto.randomUUID();
    const {rows:[row]}=await client.query(`INSERT INTO conversations(id,user_a_id,user_b_id)
      VALUES($1,$2,$3) ON CONFLICT(user_a_id,user_b_id) DO UPDATE SET user_a_id=EXCLUDED.user_a_id RETURNING id`,[id,...ids]);
    await client.query('INSERT INTO conversation_members(conversation_id,user_id) VALUES($1,$2),($1,$3) ON CONFLICT DO NOTHING',[row.id,...ids]);
    return row.id;
  });
}

async function insertMessage(id,from,clientId,body,invite=null) {
  return transaction(async client=>{
    const row=await membership(id,from,client,true);
    const {rows:[prior]}=await client.query(
      'SELECT * FROM direct_messages WHERE conversation_id=$1 AND sender_id=$2 AND client_id=$3',[id,from,clientId]);
    if(prior) return {message:publicMessage(prior),to:row.other_id};
    ensure((await relationship(from,row.other_id,client,true))?.status==='accepted',403,'Отправлять сообщения могут друзья.');
    const {rows:[msg]}=await client.query(`INSERT INTO direct_messages(conversation_id,sender_id,client_id,body,room_id,invite_code)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[id,from,clientId,body,invite?.room||null,invite?.invite||null]);
    await client.query('UPDATE conversations SET updated_at=now() WHERE id=$1',[id]);
    await client.query('UPDATE conversation_members SET hidden_at=NULL WHERE conversation_id=$1',[id]);
    return {message:publicMessage(msg),to:row.other_id};
  });
}

export function mountMessages(app,io) {
  const update=(id,from,to,deletedId)=>io.to('user:'+from).to('user:'+to).emit('direct-update',
    {conversationId:id,...(deletedId?{deletedId}:{})});
  const updateUnread=userId=>io.to('user:'+userId).emit('direct-unread');
  app.get('/api/dialogs/unread',requireUser(async (req,res)=>{
    const {rows:[row]}=await query(`SELECT count(*) AS unread FROM conversation_members m
      JOIN direct_messages d ON ${unreadMessages}
      WHERE m.user_id=$1 AND m.hidden_at IS NULL`,[req.user.id]);
    res.json({unread:Number(row.unread)});
  }));
  app.get('/api/dialogs',requireUser(async (req,res)=>{
    const q=text(req.query.q,80).toLowerCase();
    const {rows}=await query(`SELECT c.id AS conversation_id,c.updated_at,u.id,u.login,u.nickname,u.role,u.avatar_key,
      dm.body,dm.deleted_at,dm.created_at,dm.room_id,
      (SELECT count(*) FROM direct_messages d WHERE ${unreadMessages}) AS unread
      FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id
      JOIN users u ON u.id=CASE WHEN c.user_a_id=$1 THEN c.user_b_id ELSE c.user_a_id END
      LEFT JOIN LATERAL (SELECT * FROM direct_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) dm ON true
      WHERE m.user_id=$1 AND m.hidden_at IS NULL
        AND ($2='' OR strpos(lower(u.nickname),$2)>0 OR strpos(u.login,$2)>0)
      ORDER BY c.updated_at DESC,c.id LIMIT 100`,[req.user.id,q]);
    res.json({dialogs:rows.map(row=>({id:row.conversation_id,person:person(row),at:row.created_at||row.updated_at,
      preview:row.deleted_at?'Сообщение удалено':row.room_id?'Приглашение в кинозал':row.body||'',unread:Number(row.unread)}))});
  }));
  app.post('/api/dialogs',requireUser(async (req,res)=>{
    rate(req);
    res.json({id:await openDialog(req.user.id,req.body?.userId)});
  }));
  app.get('/api/dialogs/:id/messages',requireUser(async (req,res)=>{
    const id=req.params.id,row=await membership(id,req.user.id);
    const before=req.query.before;
    ensure(before===undefined||numeric(before),400,'Неверная страница.');
    const {rows}=await query(`SELECT * FROM direct_messages WHERE conversation_id=$1
      AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 41`,[id,before??null]);
    const more=rows.length>40;
    const {rows:[other]}=await query('SELECT id,login,nickname,role,avatar_key FROM users WHERE id=$1',[row.other_id]);
    res.json({person:person(other),canSend:(await relationship(req.user.id,row.other_id))?.status==='accepted',
      readByOther:String(row.other_read),messages:rows.slice(0,40).reverse().map(publicMessage),more});
  }));
  app.post('/api/dialogs/:id/messages',requireUser(async (req,res)=>{
    rate(req);
    const body=typeof req.body?.body==='string'?req.body.body.trim():'';
    ensure(body && body.length<=2000 && uuid(req.body.clientId),400,'Сообщение должно содержать до 2000 символов.');
    const {message,to}=await insertMessage(req.params.id,req.user.id,req.body.clientId,body);
    update(req.params.id,req.user.id,to);
    res.status(201).json({message});
  }));
  app.post('/api/dialogs/:id/read',requireUser(async (req,res)=>{
    const id=req.params.id,row=await membership(id,req.user.id);
    ensure(numeric(req.body?.through),400,'Неверная отметка прочтения.');
    const result=await query(`UPDATE conversation_members SET last_read_id=$3
      WHERE conversation_id=$1 AND user_id=$2 AND last_read_id<$3
      AND EXISTS (SELECT 1 FROM direct_messages WHERE conversation_id=$1 AND id=$3)`,[id,req.user.id,req.body.through]);
    if(result.rowCount) {
      io.to('user:'+row.other_id).emit('direct-read',{conversationId:id,through:req.body.through});
      updateUnread(req.user.id);
    }
    res.json({ok:true});
  }));
  app.delete('/api/dialogs/:id/messages/:message',requireUser(async (req,res)=>{
    rate(req);
    const id=req.params.id,row=await membership(id,req.user.id);
    ensure(numeric(req.params.message),404,'Сообщение не найдено.');
    const result=await query(`UPDATE direct_messages SET deleted_at=now(),body='',room_id=NULL,invite_code=NULL
      WHERE conversation_id=$1 AND id=$2 AND sender_id=$3 AND deleted_at IS NULL`,[id,req.params.message,req.user.id]);
    ensure(result.rowCount,404,'Сообщение не найдено.');
    update(id,req.user.id,row.other_id,req.params.message);
    res.json({ok:true});
  }));
  app.delete('/api/dialogs/:id',requireUser(async (req,res)=>{
    const id=req.params.id;
    await membership(id,req.user.id);
    await query('UPDATE conversation_members SET hidden_at=now() WHERE conversation_id=$1 AND user_id=$2',[id,req.user.id]);
    updateUnread(req.user.id);
    res.json({ok:true});
  }));
  app.post('/api/friends/:id/invite',requireUser(async (req,res)=>{
    rate(req);
    const to=req.params.id;
    ensure(uuid(to) && to!==req.user.id,400,'Выбери друга.');
    ensure((await relationship(req.user.id,to))?.status==='accepted',403,'Приглашение можно отправить другу.');
    const id=await openDialog(req.user.id,to);
    const invite=await newInvite(req.user,to);
    const {message}=await insertMessage(id,req.user.id,crypto.randomUUID(),'Приглашение в кинозал',invite);
    update(id,req.user.id,to);
    res.status(201).json({id,message});
  }));

  app.get('/api/export',requireUser(async (req,res)=>{
    const id=req.user.id;
    const {rows:[profile]}=await query(`SELECT u.id,u.login,u.nickname,u.friend_code,u.role,u.bio,u.avatar_key,u.created_at,p.settings
      FROM users u LEFT JOIN profile_privacy p ON p.user_id=u.id WHERE u.id=$1`,[id]);
    const {rows:friends}=await query('SELECT * FROM friendships WHERE user_a_id=$1 OR user_b_id=$1',[id]);
    const {rows:messages}=await query(`SELECT m.conversation_id,m.id,m.sender_id,m.body,m.created_at,m.deleted_at
      FROM direct_messages m JOIN conversation_members c ON c.conversation_id=m.conversation_id WHERE c.user_id=$1
      ORDER BY m.id`,[id]);
    const {rows:history}=await query(`SELECT w.id,w.movie_id,w.movie_title,w.media_type,w.started_at,w.ended_at,w.status,p.credited_seconds
      FROM watch_sessions w JOIN watch_participants p ON p.watch_session_id=w.id WHERE p.user_id=$1 ORDER BY w.started_at DESC`,[id]);
    const {rows:shared}=await query('SELECT * FROM shared_watch_intervals WHERE user_a_id=$1 OR user_b_id=$1 ORDER BY slot',[id]);
    res.attachment('remedium-cinema-data.json').json({version:1,exportedAt:new Date(),profile,friends,messages,history,shared});
  }));
}
