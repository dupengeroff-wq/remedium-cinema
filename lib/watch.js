import crypto from 'node:crypto';
import {transaction,query} from './db.js';

export const slotMs=5000;
const maxGap=6500;

// Credit only complete, uninterrupted server-clock buckets between verified observations.
export function advanceEvidence(previous,next) {
  const result={...next,from:next.at,lastSlot:Math.floor(next.at/slotMs)-1};
  if (!previous || previous.mediaId!==next.mediaId || previous.epoch!==next.epoch) return {state:result,slots:[]};
  const elapsed=(next.at-previous.at)/1000;
  const progressed=next.position-previous.position;
  if (elapsed<1.4) return {state:previous,slots:[]};
  if (elapsed>maxGap/1000 || progressed<elapsed-.55 || progressed>elapsed+.8) return {state:result,slots:[]};
  result.from=previous.from;
  const first=Math.max(previous.lastSlot+1,Math.ceil(result.from/slotMs));
  const stop=Math.floor(next.at/slotMs);
  const slots=[];
  for(let slot=first;slot<stop;slot++)slots.push(slot);
  result.lastSlot=Math.max(previous.lastSlot,stop-1);
  return {state:result,slots};
}

export function createWatchTracker() {
  const evidence=new Map();
  const writes=new WeakMap();
  function invalidate(room) { room.watchEpoch=(room.watchEpoch||0)+1; }
  function forget(socket) { evidence.delete(socket.id); }
  function queue(room,work) {
    const write=(writes.get(room)||Promise.resolve()).then(work);
    writes.set(room,write.catch(()=>{}));
    return write;
  }
  async function finish(room,completed=false) {
    invalidate(room);
    const id=room.watchId;
    room.watchId=null;
    room.watchLast=0;
    if (id) await queue(room,()=>query(`UPDATE watch_sessions SET status=$2,ended_at=updated_at
      WHERE id=$1 AND status='running'`,[id,completed?'completed':'interrupted']));
  }
  async function report(socket,room,payload) {
    const userId=socket.data.auth?.id;
    const now=Date.now();
    const elapsed=room?.playing?Math.max(0,now-room.updated)/1000:0;
    const clock=room?room.time+elapsed:0;
    if(!userId || !room?.media || !room.playing || payload?.mediaId!==room.mediaId || payload.playing!==true
       || typeof payload.position!=='number' || !Number.isFinite(payload.position) || payload.position<0
       || Math.abs(payload.position-clock)>4) {
      forget(socket);
      return;
    }
    const previous=evidence.get(socket.id);
    const next={at:now,position:payload.position,mediaId:room.mediaId,epoch:room.watchEpoch||0};
    const {state,slots}=advanceEvidence(previous,next);
    evidence.set(socket.id,state);
    if(!slots.length) return;
    if(room.watchId && now-room.watchLast>20000) {
      finish(room).catch(error=>console.warn('Watch close:',error.code||error.name));
    }
    if(!room.watchId) room.watchId=crypto.randomUUID();
    room.watchLast=now;
    const id=room.watchId;
    const source=room.media;
    const url=new URL(source.url);
    const vkParams=source.type==='vk'?new URL(source.embed).searchParams:null;
    const identity=vkParams? `${vkParams.get('oid')}_${vkParams.get('id')}` : (source.id||url.origin+url.pathname);
    const movie=crypto.createHash('sha256').update(source.type+':'+identity).digest('hex');
    const title=room.title||'Видео';
    const poster=room.watchPoster||null;
    await queue(room,()=>transaction(async client=>{
      await client.query(`INSERT INTO watch_sessions(id,room_id,movie_id,movie_title,media_type,poster_key,started_at,updated_at,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running') ON CONFLICT (id) DO NOTHING`,
        [id,room.id,source.type+':'+movie,title,source.type,poster,new Date(slots[0]*slotMs),new Date(now)]);
      const {rows:[entry]}=await client.query('SELECT status FROM watch_sessions WHERE id=$1 FOR UPDATE',[id]);
      if(entry.status!=='running') return;
      const {rows:credited}=await client.query(`INSERT INTO watch_credits(user_id,slot,watch_session_id)
        SELECT $1,unnest($2::bigint[]),$3 ON CONFLICT DO NOTHING RETURNING slot`,[userId,slots,id]);
      if(!credited.length) return;
      await client.query(`INSERT INTO watch_participants(watch_session_id,user_id,credited_seconds)
        VALUES($1,$2,$3) ON CONFLICT(watch_session_id,user_id) DO UPDATE
        SET credited_seconds=watch_participants.credited_seconds+EXCLUDED.credited_seconds`,[id,userId,credited.length*5]);
      await client.query(`INSERT INTO shared_watch_intervals(watch_session_id,user_a_id,user_b_id,slot)
        SELECT $1,least($2::uuid,user_id),greatest($2::uuid,user_id),slot FROM watch_credits
        WHERE watch_session_id=$1 AND user_id<>$2 AND slot=ANY($3::bigint[]) ON CONFLICT DO NOTHING`,
        [id,userId,credited.map(row=>row.slot)]);
      await client.query('UPDATE watch_sessions SET updated_at=greatest(updated_at,$2) WHERE id=$1',[id,new Date((Math.max(...credited.map(row=>Number(row.slot)))+1)*slotMs)]);
    }));
  }
  return {invalidate,forget,finish,report};
}
