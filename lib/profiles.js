import {query} from './db.js';
import {defaultPrivacy,requireUser,publicUser} from './auth.js';
import {ensure,pair,text,uuid} from './http.js';

export const person = row => ({
  id:row.id,login:row.login,nickname:row.nickname,role:row.role,avatar:row.avatar_key?'/api/avatars/'+row.id:null
});

export async function relationship(a,b,db={query},lock=false) {
  if(a===b) return null;
  const {rows:[row]}=await db.query('SELECT * FROM friendships WHERE user_a_id=$1 AND user_b_id=$2'+(lock?' FOR UPDATE':''),pair(a,b));
  return row||null;
}
const relationType=(row,id)=>!row?'none':row.status==='accepted'?'friend':row.requester_id===id?'outgoing':'incoming';

const personalSql=`
  SELECT coalesce(sum(p.credited_seconds),0)::bigint AS seconds,
    count(DISTINCT w.movie_id) AS films, count(*) AS sessions,
    (SELECT count(DISTINCT (to_timestamp(slot*5) AT TIME ZONE 'UTC')::date) FROM watch_credits WHERE user_id=$1) AS days,
    (SELECT to_timestamp((max(slot)+1)*5) FROM watch_credits WHERE user_id=$1) AS last,
    (SELECT count(DISTINCT watch_session_id) FROM shared_watch_intervals WHERE user_a_id=$1 OR user_b_id=$1) AS shared_count
  FROM watch_participants p JOIN watch_sessions w ON w.id=p.watch_session_id
  WHERE p.user_id=$1 AND p.credited_seconds>0`;
const historySql=`
  SELECT w.id,w.movie_id,w.movie_title,w.media_type,w.poster_key,w.started_at,
    CASE WHEN w.status='running' AND w.updated_at<now()-interval '25 seconds' THEN w.updated_at ELSE w.ended_at END AS ended_at,
    CASE WHEN w.status='running' AND w.updated_at<now()-interval '25 seconds' THEN 'interrupted' ELSE w.status END AS status,
    p.credited_seconds
  FROM watch_participants p JOIN watch_sessions w ON w.id=p.watch_session_id
  WHERE p.user_id=$1 AND p.credited_seconds>0 ORDER BY w.started_at DESC,w.id DESC`;

async function historyRows(id,viewer,offset=0) {
  const {rows}=await query(historySql+' LIMIT 50 OFFSET $2',[id,offset]);
  if(!rows.length || viewer!==id) return rows;
  const participants=(await query(`
    SELECT p.watch_session_id,u.id,u.login,u.nickname,u.role,u.avatar_key
    FROM watch_participants p JOIN users u ON u.id=p.user_id
    WHERE p.watch_session_id=ANY($1::uuid[]) AND p.user_id<>$2 AND p.credited_seconds>0
      AND EXISTS (SELECT 1 FROM shared_watch_intervals s
        WHERE s.watch_session_id=p.watch_session_id AND
          ((s.user_a_id=$2 AND s.user_b_id=p.user_id) OR (s.user_b_id=$2 AND s.user_a_id=p.user_id)))`,
    [rows.map(row=>row.id),id])).rows;
  return rows.map(row=>({...row,participants:participants.filter(item=>item.watch_session_id===row.id).map(person)}));
}

async function jointRows(id,other) {
  return (await query(`
    WITH joint AS (
      SELECT watch_session_id,slot,CASE WHEN user_a_id=$1 THEN user_b_id ELSE user_a_id END AS partner
      FROM shared_watch_intervals WHERE (user_a_id=$1 OR user_b_id=$1)
        AND ($2::uuid IS NULL OR (CASE WHEN user_a_id=$1 THEN user_b_id ELSE user_a_id END)=$2)
    ), totals AS (
      SELECT j.partner,count(*)*5 AS seconds,count(DISTINCT j.watch_session_id) AS sessions,
        count(DISTINCT w.movie_id) AS films,count(DISTINCT (to_timestamp(j.slot*5) AT TIME ZONE 'UTC')::date) AS days,
        to_timestamp(min(j.slot)*5) AS first,to_timestamp((max(j.slot)+1)*5) AS last
      FROM joint j JOIN watch_sessions w ON w.id=j.watch_session_id GROUP BY j.partner
    )
    SELECT totals.*,u.id,u.login,u.nickname,u.role,u.avatar_key FROM totals JOIN users u ON u.id=totals.partner
    ORDER BY totals.last DESC`,[id,other])).rows;
}

async function sharedHistoryRows(a,b,limit=50) {
  return (await query(`
    SELECT w.id,w.movie_title,w.media_type,w.poster_key,
      to_timestamp(min(s.slot)*5) AS started_at,to_timestamp((max(s.slot)+1)*5) AS ended_at,
      count(*)*5 AS credited_seconds,
      CASE WHEN w.status='running' AND w.updated_at<now()-interval '25 seconds' THEN 'interrupted' ELSE w.status END AS status
    FROM shared_watch_intervals s JOIN watch_sessions w ON w.id=s.watch_session_id
    WHERE s.user_a_id=$1 AND s.user_b_id=$2
    GROUP BY w.id ORDER BY max(s.slot) DESC LIMIT $3`,[...pair(a,b),limit])).rows;
}

async function profileInfo(id) {
  const {rows:[row]}=await query(`SELECT u.id,u.login,u.nickname,u.role,u.avatar_key,u.bio,u.created_at,
    u.friend_code, p.settings FROM users u LEFT JOIN profile_privacy p ON p.user_id=u.id WHERE u.id=$1`,[id]);
  ensure(row,404,'Профиль не найден.');
  return {row,privacy:{...defaultPrivacy,...row.settings}};
}

async function friendsList(id) {
  return (await query(`SELECT u.id,u.login,u.nickname,u.role,u.avatar_key FROM friendships f
    JOIN users u ON u.id=CASE WHEN f.user_a_id=$1 THEN f.user_b_id ELSE f.user_a_id END
    WHERE (f.user_a_id=$1 OR f.user_b_id=$1) AND f.status='accepted'
    ORDER BY lower(u.nickname),u.id LIMIT 500`,[id])).rows.map(person);
}

export function mountProfiles(app,io) {
  const online=id=>io.sockets.adapter.rooms.get('user:'+id)?.size>0;
  app.get('/api/profiles/:id',requireUser(async (req,res)=>{
    const id=req.params.id;
    ensure(uuid(id),404,'Профиль не найден.');
    const {row,privacy}=await profileInfo(id);
    const own=req.user.id===id;
    const preview=own && req.query.view==='friend';
    const self=own&&!preview;
    const relation=own?null:await relationship(req.user.id,id);
    const friend=preview?req.query.friend:undefined;
    if(friend!==undefined) {
      ensure(uuid(friend) && (await relationship(id,friend))?.status==='accepted',404,'Друг не найден.');
    }
    const canSeeFriends=self || privacy.friends===true;
    const canSeeHistory=self || privacy.history===true;
    const visible={
      seconds:self || privacy.watchTime===true, films:self || privacy.films===true,
      sessions:self || privacy.sessions===true, days:self || privacy.watchTime===true,
      last:self || privacy.watchTime===true, shared_count:self || privacy.shared===true
    };
    const personal={};
    if((self || privacy.hideStats!==true) && Object.values(visible).some(Boolean)) {
      const {rows:[stats]}=await query(personalSql,[id]);
      for(const [key,enabled] of Object.entries(visible)) {
        if(enabled) personal[key]=key==='last'?stats.last:Number(stats[key]);
      }
    }
    const personalHidden=!self && (privacy.hideStats===true || !Object.keys(personal).length);
    const jointViewer=preview?friend:req.user.id;
    const sharedAllowed=self || (jointViewer && privacy.shared===true && privacy.hideStats!==true);
    const joint=sharedAllowed?await jointRows(id,self?null:jointViewer):null;
    const offset=Math.min(10000,Math.max(0,Number.parseInt(req.query.offset,10)||0));
    const result={
      person:{...person(row),bio:row.bio,...(self||privacy.registration===true?{registeredAt:row.created_at}:{}),
        ...(self||privacy.presence===true?{online:online(id)}:{})},
      self,preview,previewFriend:friend??null,relationship:relationType(relation,req.user.id),
      canSeeFriends,personal,personalHidden,shared:(self||joint?.length?joint:null)?.map(j=>({
        person:person(j),seconds:Number(j.seconds),films:Number(j.films),sessions:Number(j.sessions),days:Number(j.days),first:j.first,last:j.last
      }))??null,
      historyHidden:!canSeeHistory,history:canSeeHistory?await historyRows(id,self?req.user.id:null,offset):null
    };
    if(self){result.privacy=privacy;result.friendCode=row.friend_code}
    res.json(result);
  }));

  app.get('/api/profiles/:id/friends',requireUser(async (req,res)=>{
    ensure(uuid(req.params.id),404,'Профиль не найден.');
    const {privacy}=await profileInfo(req.params.id);
    const own=req.user.id===req.params.id && req.query.view!=='friend';
    ensure(own || privacy.friends===true,404,'Список друзей недоступен.');
    res.json({friends:await friendsList(req.params.id)});
  }));

  app.get('/api/profile/friend-preview',requireUser(async (req,res)=>{
    res.json({friends:await friendsList(req.user.id)});
  }));

  app.get('/api/shared/:id',requireUser(async (req,res)=>{
    ensure(uuid(req.params.id) && req.params.id!==req.user.id,404,'Профиль не найден.');
    const {row}=await profileInfo(req.params.id);
    res.json({person:person(row),history:await sharedHistoryRows(req.user.id,req.params.id)});
  }));

  app.patch('/api/profile',requireUser(async (req,res)=>{
    const nickname=text(req.body?.nickname,40),bio=text(req.body?.bio,240);
    ensure(nickname,400,'Укажи ник.');
    const {rows:[row]}=await query('UPDATE users SET nickname=$2,bio=$3,updated_at=now() WHERE id=$1 RETURNING *',[req.user.id,nickname,bio]);
    io.to('user:'+req.user.id).emit('profile-updated',{nickname});
    res.json({user:publicUser(row)});
  }));

  app.patch('/api/profile/privacy',requireUser(async (req,res)=>{
    const settings={};
    for(const key of Object.keys(defaultPrivacy)){
      ensure(typeof req.body?.[key]==='boolean',400,'Некорректные настройки приватности.');
      settings[key]=req.body[key];
    }
    await query(`INSERT INTO profile_privacy(user_id,settings) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET settings=EXCLUDED.settings,updated_at=now()`,
      [req.user.id,JSON.stringify(settings)]);
    res.json({privacy:settings});
  }));

  app.get('/api/people',requireUser(async (req,res)=>{
    const q=text(req.query.q,80).normalize('NFKC').toLowerCase();
    ensure(q.length>=2,400,'Введи хотя бы два символа.');
    const {rows}=await query(`SELECT id,login,nickname,role,avatar_key FROM users
      WHERE id<>$1 AND (left(login,char_length($2))=$2 OR friend_code=$2)
      ORDER BY (login=$2 OR friend_code=$2) DESC,login LIMIT 20`,[req.user.id,q]);
    res.json({people:rows.map(person)});
  }));

  app.get('/api/friends',requireUser(async (req,res)=>{
    const {rows}=await query(`SELECT u.id,u.login,u.nickname,u.role,u.avatar_key,f.requester_id,f.status
      FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_a_id=$1 THEN f.user_b_id ELSE f.user_a_id END
      WHERE f.user_a_id=$1 OR f.user_b_id=$1 ORDER BY f.created_at DESC LIMIT 500`,[req.user.id]);
    res.json({people:rows.map(row=>({...person(row),relationship:relationType(row,req.user.id)}))});
  }));

  app.post('/api/friends/:id',requireUser(async (req,res)=>{
    const id=req.params.id;
    ensure(uuid(id)&&id!==req.user.id,400,'Выбери другого пользователя.');
    ensure((await query('SELECT 1 FROM users WHERE id=$1',[id])).rowCount,404,'Профиль не найден.');
    await query(`INSERT INTO friendships(user_a_id,user_b_id,requester_id,status)
      VALUES($1,$2,$3,'pending') ON CONFLICT DO NOTHING`,[...pair(id,req.user.id),req.user.id]);
    io.to('user:'+id).emit('friends-update');
    res.json({relationship:relationType(await relationship(id,req.user.id),req.user.id)});
  }));

  app.patch('/api/friends/:id',requireUser(async (req,res)=>{
    const id=req.params.id;
    ensure(uuid(id)&&id!==req.user.id,404,'Заявка не найдена.');
    ensure(req.body?.action==='accept'||req.body?.action==='decline',400,'Неизвестное действие.');
    const args=[...pair(id,req.user.id),req.user.id];
    const result=req.body.action==='accept'
      ? await query(`UPDATE friendships SET status='accepted',accepted_at=now()
        WHERE user_a_id=$1 AND user_b_id=$2 AND status='pending' AND requester_id<>$3`,args)
      : await query(`DELETE FROM friendships WHERE user_a_id=$1 AND user_b_id=$2 AND status='pending' AND requester_id<>$3`,args);
    ensure(result.rowCount,404,'Заявка не найдена.');
    io.to('user:'+id).emit('friends-update');
    res.json({ok:true});
  }));

  app.delete('/api/friends/:id',requireUser(async (req,res)=>{
    const id=req.params.id;
    ensure(uuid(id)&&id!==req.user.id,404,'Профиль не найден.');
    await query('DELETE FROM friendships WHERE user_a_id=$1 AND user_b_id=$2',pair(id,req.user.id));
    io.to('user:'+id).emit('friends-update');
    res.json({ok:true});
  }));
}
