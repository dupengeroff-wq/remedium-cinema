import crypto from 'node:crypto';
import {query,transaction} from './db.js';
import {hashToken} from './auth.js';
import {ensure} from './http.js';
import {loadLegacyCreatorRoom} from './legacy.js';

export async function ownRoom(user) {
  const old=await query('SELECT * FROM cinema_rooms WHERE owner_id=$1',[user.id]);
  if(old.rowCount) return old.rows[0];
  const legacy=user.role==='creator'?await loadLegacyCreatorRoom():null;
  await query(`INSERT INTO cinema_rooms(id,owner_id,state,history)
    VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id) DO NOTHING`,[
    legacy?.id||crypto.randomBytes(16).toString('hex'),user.id,
    JSON.stringify(legacy?.state||{}),JSON.stringify((legacy?.history||[]).slice(-100))
  ]);
  return (await query('SELECT * FROM cinema_rooms WHERE owner_id=$1',[user.id])).rows[0];
}

export async function getRoomRecord(id) {
  return (await query('SELECT * FROM cinema_rooms WHERE id=$1',[id])).rows[0];
}

export async function admitGuest(roomId,userId,invite,hasOtherGuest) {
  return transaction(async client=>{
    const {rows:[row]}=await client.query('SELECT * FROM cinema_rooms WHERE id=$1 FOR UPDATE',[roomId]);
    ensure(row,404,'Комната не найдена.');
    if(row.owner_id===userId || row.guest_id===userId) return row;
    ensure(!hasOtherGuest(),409,'В комнате уже есть второй участник.');
    ensure(typeof invite==='string' && /^[a-f0-9]{32}$/.test(invite) &&
      row.invite_hash===hashToken(invite) && new Date(row.invite_expires_at).getTime()>Date.now() &&
      (!row.invite_for || row.invite_for===userId),403,'Нужна свежая ссылка от создателя комнаты.');
    const {rows:[updated]}=await client.query(`UPDATE cinema_rooms SET guest_id=$2,
      invite_hash=NULL,invite_for=NULL,invite_expires_at=NULL,updated_at=now()
      WHERE id=$1 RETURNING *`,[roomId,userId]);
    return updated;
  });
}

export async function newInvite(user,recipient=null) {
  const room=await ownRoom(user);
  const code=crypto.randomBytes(16).toString('hex');
  await query(`UPDATE cinema_rooms SET invite_hash=$2,invite_for=$3,
    invite_expires_at=now()+interval '12 hours',updated_at=now() WHERE id=$1 AND owner_id=$4`,
    [room.id,hashToken(code),recipient,user.id]);
  return {room:room.id,invite:code};
}

export async function saveRoom(id,state,history) {
  await query('UPDATE cinema_rooms SET state=$2,history=$3,updated_at=now() WHERE id=$1',
    [id,JSON.stringify(state),JSON.stringify(history)]);
}
