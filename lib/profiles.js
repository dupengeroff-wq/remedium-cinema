import {query} from './db.js';
import {defaultPrivacy,requireUser,publicUser} from './auth.js';
import {catalogSearchAvailable,withHistoryCovers} from './film-covers.js';
import {ensure,pair,text,uuid} from './http.js';

export const person = row => ({
  id:row.id,login:row.login,nickname:row.nickname,avatar:row.avatar_key?'/api/avatars/'+row.id:null
});

export async function relationship(a,b,db={query},lock=false) {
  if(a===b) return null;
  const {rows:[row]}=await db.query('SELECT * FROM friendships WHERE user_a_id=$1 AND user_b_id=$2'+(lock?' FOR UPDATE':''),pair(a,b));
  return row||null;
}
const relationType=(row,id)=>!row?'none':row.status==='accepted'?'friend':row.requester_id===id?'outgoing':'incoming';
const profileThemes=new Set(['nefertiti','hello-kitty-pink','sakura-night']);

const personalSql=`
  WITH visible_credits AS (
    SELECT c.slot FROM watch_credits c LEFT JOIN watch_participants p USING (watch_session_id,user_id)
    WHERE c.user_id=$1 AND p.history_deleted_at IS NULL
  )
  SELECT coalesce(sum(p.credited_seconds),0)::bigint AS seconds,
    count(DISTINCT w.movie_id) AS films, count(*) AS sessions,
    (SELECT count(DISTINCT (to_timestamp(slot*5) AT TIME ZONE 'UTC')::date) FROM visible_credits) AS days,
    (SELECT to_timestamp((max(slot)+1)*5) FROM visible_credits) AS last,
    (SELECT count(DISTINCT s.watch_session_id) FROM profile_shared_watch_intervals s
      LEFT JOIN watch_participants own ON own.watch_session_id=s.watch_session_id AND own.user_id=s.profile_id
      WHERE s.profile_id=$1 AND own.history_deleted_at IS NULL) AS shared_count
  FROM watch_participants p JOIN watch_sessions w ON w.id=p.watch_session_id
  WHERE p.user_id=$1 AND p.credited_seconds>0 AND p.history_deleted_at IS NULL`;
const coverColumns=`
    coalesce(w.history_title,r.title,d.title) AS selected_title,
    CASE WHEN w.history_cover_set THEN w.history_poster_url ELSE coalesce(r.poster_url,d.poster_url) END AS selected_poster,
    CASE WHEN w.history_title IS NOT NULL THEN w.history_release_year
      WHEN r.title IS NOT NULL THEN r.release_year ELSE coalesce(r.release_year,d.release_year) END AS release_year`;
const coverJoins=`
  LEFT JOIN watch_movie_details d ON d.movie_id=w.movie_id
  LEFT JOIN watch_room_movie_details r ON r.room_id=w.room_id AND r.movie_id=w.movie_id`;
const historySql=`
  SELECT w.id,w.room_id,w.movie_id,w.movie_title,w.media_type,w.source_id,w.poster_key,w.started_at,
    ${coverColumns},w.history_revision AS poster_revision,
    CASE WHEN w.status='running' AND w.updated_at<now()-interval '25 seconds' THEN w.updated_at ELSE w.ended_at END AS ended_at,
    CASE WHEN w.status='running' AND w.updated_at<now()-interval '25 seconds' THEN 'interrupted' ELSE w.status END AS status,
    p.credited_seconds
  FROM watch_participants p JOIN watch_sessions w ON w.id=p.watch_session_id
  ${coverJoins}
  WHERE p.user_id=$1 AND p.credited_seconds>0 AND p.history_deleted_at IS NULL
  ORDER BY w.started_at DESC,w.id DESC`;

async function historyRows(id,viewer,offset) {
  const {rows}=await query(historySql+' LIMIT 50 OFFSET $2',[id,offset]);
  const history=await withHistoryCovers(rows,viewer===id);
  if(!history.length || viewer!==id) return history;
  const {rows:participants}=await query(`
    SELECT DISTINCT s.watch_session_id,u.id,u.nickname
    FROM shared_watch_intervals s
    JOIN users u ON u.id=CASE WHEN s.user_a_id=$2 THEN s.user_b_id ELSE s.user_a_id END
    JOIN watch_participants p ON p.watch_session_id=s.watch_session_id AND p.user_id=u.id AND p.credited_seconds>0
    LEFT JOIN profile_privacy privacy ON privacy.user_id=u.id
    WHERE s.watch_session_id=ANY($1::uuid[]) AND $2 IN (s.user_a_id,s.user_b_id)
      AND privacy.settings->'hideProfile' IS DISTINCT FROM 'true'::jsonb
      AND privacy.settings->'hideStats' IS DISTINCT FROM 'true'::jsonb
      AND privacy.settings->'shared' IS DISTINCT FROM 'false'::jsonb
      AND privacy.settings->'history' IS DISTINCT FROM 'false'::jsonb
    ORDER BY u.nickname,u.id`,[history.map(row=>row.id),id]);
  const byWatch=new Map();
  for(const {watch_session_id,...participant} of participants){
    if(!byWatch.has(watch_session_id)) byWatch.set(watch_session_id,[]);
    byWatch.get(watch_session_id).push(participant);
  }
  return history.map(row=>({...row,participants:byWatch.get(row.id)||[]}));
}

const jointStatsSql=`count(DISTINCT s.slot)*5 AS seconds,count(DISTINCT s.watch_session_id) AS sessions,
  count(DISTINCT w.movie_id) AS films,count(DISTINCT (to_timestamp(s.slot*5) AT TIME ZONE 'UTC')::date) AS days,
  to_timestamp(min(s.slot)*5) AS first,to_timestamp((max(s.slot)+1)*5) AS last`;
const visibleSharedHistory=`
  FROM profile_shared_watch_intervals s JOIN watch_sessions w ON w.id=s.watch_session_id
  LEFT JOIN watch_participants p ON p.watch_session_id=s.watch_session_id AND p.user_id=s.profile_id`;
const jointStats=row=>({seconds:Number(row.seconds),films:Number(row.films),sessions:Number(row.sessions),
  days:Number(row.days),first:row.first,last:row.last});

async function jointRows(id,other) {
  const {rows}=await query(`
    SELECT u.id,u.login,u.nickname,u.role,u.avatar_key,${jointStatsSql}
    ${visibleSharedHistory}
      JOIN users u ON u.id=s.partner_id
    WHERE s.profile_id=$1 AND p.history_deleted_at IS NULL AND ($2::uuid IS NULL OR s.partner_id=$2)
    GROUP BY u.id ORDER BY last DESC`,[id,other]);
  return rows.map(row=>({person:person(row),...jointStats(row)}));
}

async function jointTotals(id) {
  const {rows:[row]}=await query(`SELECT ${jointStatsSql}
    ${visibleSharedHistory}
    WHERE s.profile_id=$1 AND p.history_deleted_at IS NULL`,[id]);
  return jointStats(row);
}

async function sharedHistoryRows(a,b,limit=50) {
  const {rows}=await query(`
    SELECT w.id,w.room_id,w.movie_id,w.movie_title,w.media_type,w.source_id,w.poster_key,${coverColumns},
      to_timestamp(min(s.slot)*5) AS started_at,to_timestamp((max(s.slot)+1)*5) AS ended_at,
      count(*)*5 AS credited_seconds,
      CASE WHEN w.status='running' AND w.updated_at<now()-interval '25 seconds' THEN 'interrupted' ELSE w.status END AS status
    ${visibleSharedHistory}
    ${coverJoins}
    WHERE s.profile_id=$1 AND p.history_deleted_at IS NULL AND s.partner_id=$2
    GROUP BY w.id,p.watch_session_id,p.user_id,d.movie_id,r.room_id,r.movie_id ORDER BY max(s.slot) DESC LIMIT $3`,[a,b,limit]);
  return withHistoryCovers(rows);
}

async function profileInfo(id) {
  const {rows:[row]}=await query(`SELECT u.id,u.login,u.nickname,u.role,u.avatar_key,u.bio,u.created_at,
    u.friend_code,u.profile_theme,p.settings FROM users u LEFT JOIN profile_privacy p ON p.user_id=u.id WHERE u.id=$1`,[id]);
  ensure(row,404,'Профиль не найден.');
  return {row,privacy:{...defaultPrivacy,...row.settings}};
}

async function friendsList(id, mutualWith=null) {
  return (await query(`SELECT u.id,u.login,u.nickname,u.role,u.avatar_key FROM friendships f
    JOIN users u ON u.id=CASE WHEN f.user_a_id=$1 THEN f.user_b_id ELSE f.user_a_id END
    WHERE (f.user_a_id=$1 OR f.user_b_id=$1) AND f.status='accepted'
      AND ($2::uuid IS NULL OR EXISTS (
        SELECT 1 FROM friendships m WHERE m.status='accepted'
          AND m.user_a_id=least($2::uuid,u.id) AND m.user_b_id=greatest($2::uuid,u.id)
      ))
    ORDER BY lower(u.nickname),u.id LIMIT 500`,[id,mutualWith])).rows.map(person);
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
    const identity=person(row);
    const presence=self || privacy.presence===true ? {online:online(id)} : {};
    const relationshipStatus=relationType(relation,req.user.id);
    if(!self && privacy.hideProfile===true){
      return res.json({person:{...identity,...presence},self,preview,
        previewFriend:friend??null,relationship:relationshipStatus,profileHidden:true,theme:profileThemes.has(row.profile_theme)?row.profile_theme:'sakura-night'});
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
    const sharedAllowed=self || (privacy.shared===true && privacy.hideStats!==true);
    const offset=Math.min(10000,Math.max(0,Number.parseInt(req.query.offset,10)||0));
    const [shared,sharedTotal,history,{rows:[friends]},mutualFriends]=await Promise.all([
      sharedAllowed?(self||jointViewer?jointRows(id,self?null:jointViewer):[]):null,
      !self && sharedAllowed?jointTotals(id):null,
      canSeeHistory?historyRows(id,self?req.user.id:null,offset):null,
      query(`SELECT count(*) AS count FROM friendships
        WHERE status='accepted' AND (user_a_id=$1 OR user_b_id=$1)`,[id]),
      !self && canSeeFriends && jointViewer ? friendsList(id,jointViewer) : []
    ]);
    const result={
      person:{...identity,role:row.role,bio:row.bio,...(self||privacy.registration===true?{registeredAt:row.created_at}:{}),...presence},
      self,preview,previewFriend:friend??null,relationship:relationshipStatus,profileHidden:false,theme:profileThemes.has(row.profile_theme)?row.profile_theme:'sakura-night',
      canSeeFriends,friendCount:Number(friends.count),personal,personalHidden,shared,sharedTotal,
      historyHidden:!canSeeHistory,history,mutualFriends
    };
    if(self){result.privacy=privacy;result.friendCode=row.friend_code}
    if(self) result.coverEditor={searchAvailable:catalogSearchAvailable()};
    res.json(result);
  }));

  app.get('/api/profiles/:id/friends',requireUser(async (req,res)=>{
    ensure(uuid(req.params.id),404,'Профиль не найден.');
    const {privacy}=await profileInfo(req.params.id);
    const id=req.params.id;
    const own=req.user.id===id;
    const preview=own && req.query.view==='friend';
    ensure((own && !preview) || (!privacy.hideProfile && privacy.friends===true),404,'Список друзей недоступен.');
    if(own && !preview) return res.json({friends:await friendsList(id)});
    const visitor=preview?req.query.friend:req.user.id;
    if(preview && visitor===undefined) return res.json({friends:[]});
    if(preview) ensure(uuid(visitor) && (await relationship(id,visitor))?.status==='accepted',404,'Друг не найден.');
    res.json({friends:await friendsList(id,visitor)});
  }));

  app.get('/api/profile/friend-preview',requireUser(async (req,res)=>{
    res.json({friends:await friendsList(req.user.id)});
  }));

  app.get(['/api/shared/:id','/api/profile/shared/:id'],requireUser(async (req,res)=>{
    ensure(uuid(req.params.id) && req.params.id!==req.user.id,404,'Профиль не найден.');
    const {row,privacy}=await profileInfo(req.params.id);
    if(req.path.startsWith('/api/shared/')){
      ensure(!privacy.hideProfile && privacy.shared===true && !privacy.hideStats,404,'Совместные сеансы недоступны.');
    }
    res.json({person:person(row),history:await sharedHistoryRows(req.user.id,req.params.id)});
  }));

  app.patch('/api/profile',requireUser(async (req,res)=>{
    const nickname=text(req.body?.nickname,40),bio=text(req.body?.bio,240);
    ensure(nickname,400,'Укажи ник.');
    const {rows:[row]}=await query('UPDATE users SET nickname=$2,bio=$3,updated_at=now() WHERE id=$1 RETURNING *',[req.user.id,nickname,bio]);
    io.to('user:'+req.user.id).emit('profile-updated',{nickname});
    res.json({user:publicUser(row)});
  }));

  app.patch('/api/profile/theme',requireUser(async (req,res)=>{
    const theme=req.body?.theme;
    ensure(profileThemes.has(theme),400,'Такой темы профиля нет.');
    const {rows:[user]}=await query('UPDATE users SET profile_theme=$2 WHERE id=$1 RETURNING profile_theme',[req.user.id,theme]);
    ensure(user,404,'Профиль не найден.');
    res.json({theme:user.profile_theme});
  }));

  app.patch('/api/profile/privacy',requireUser(async (req,res)=>{
    const settings={};
    for(const key of Object.keys(defaultPrivacy)){
      if(key==='hideProfile' && req.body?.[key]===undefined) continue;
      ensure(typeof req.body?.[key]==='boolean',400,'Некорректные настройки приватности.');
      settings[key]=req.body[key];
    }
    const {rows:[saved]}=await query(`INSERT INTO profile_privacy(user_id,settings) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET settings=profile_privacy.settings || EXCLUDED.settings,updated_at=now()
      RETURNING settings`,[req.user.id,JSON.stringify(settings)]);
    res.json({privacy:{...defaultPrivacy,...saved.settings}});
  }));

  app.get('/api/people',requireUser(async (req,res)=>{
    const q=text(req.query.q,80).normalize('NFKC').toLowerCase();
    ensure(q.length>=2,400,'Введи хотя бы два символа.');
    const {rows}=await query(`SELECT u.id,u.login,u.nickname,u.role,u.avatar_key,f.status,f.requester_id FROM users u
      LEFT JOIN friendships f ON f.user_a_id=least($1::uuid,u.id) AND f.user_b_id=greatest($1::uuid,u.id)
      WHERE u.id<>$1 AND (left(u.login,char_length($2))=$2 OR u.friend_code=$2)
      ORDER BY (u.login=$2 OR u.friend_code=$2) DESC,u.login LIMIT 20`,[req.user.id,q]);
    res.json({people:rows.map(row=>({...person(row),relationship:relationType(row.status?row:null,req.user.id)}))});
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
