import crypto from 'node:crypto';
import {transaction,query} from '../../db/pool.js';
import {movieKey,providerVideoId} from './media.js';

import {slotMs,advanceEvidence} from './evidence.js';
export {slotMs,advanceEvidence} from './evidence.js';

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
    if(!completed){
      room.watchId=null;
      room.watchLast=0;
    }
    if(!id) return;
    const endedAt=completed?new Date():null;
    await queue(room,()=>query(`UPDATE watch_sessions SET status=$2,ended_at=greatest(updated_at,$3::timestamptz)
      WHERE id=$1 AND status='running'`,[id,completed?'completed':'interrupted',endedAt]));
    if(completed && room.watchId===id){
      room.watchId=null;
      room.watchLast=0;
    }
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
    const movie=movieKey(source);
    const title=room.title||'Видео';
    const poster=room.watchPoster||null;
    await queue(room,()=>transaction(async client=>{
      await client.query(`INSERT INTO watch_sessions(id,room_id,movie_id,movie_title,media_type,poster_key,started_at,updated_at,status,source_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9) ON CONFLICT (id) DO NOTHING`,
        [id,room.id,movie,title,source.type,poster,new Date(slots[0]*slotMs),new Date(now),providerVideoId(source)]);
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
