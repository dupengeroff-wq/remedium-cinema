// One transcript per viewing room. Keep the same 250-message window as the client.
// A lease allows navigation, network interruptions and process restarts between visits.
import {randomBytes} from 'node:crypto';
import {transaction,query} from '../../db/pool.js';
import {HttpError} from '../../http/helpers.js';

const freshId=()=>randomBytes(16).toString('hex');
const lease="interval '12 hours'";

export async function openChat(room,guestId,{mediaId=room.mediaId,renew=false}={}){
  const fresh=freshId();
  const row=await transaction(async db=>{
    const result=await db.query(`INSERT INTO cinema_room_chats AS old
      (room_id,chat_id,media_id,guest_id,expires_at)
      VALUES ($1,$2,$3,$4,now()+${lease})
      ON CONFLICT (room_id) DO UPDATE SET
        chat_id=CASE WHEN $5 OR old.expires_at<=now() OR old.media_id IS DISTINCT FROM EXCLUDED.media_id
          OR (old.guest_id IS NOT NULL AND old.guest_id IS DISTINCT FROM EXCLUDED.guest_id)
          THEN EXCLUDED.chat_id ELSE old.chat_id END,
        media_id=EXCLUDED.media_id,guest_id=EXCLUDED.guest_id,expires_at=EXCLUDED.expires_at
      RETURNING chat_id,messages`,[room.id,fresh,mediaId,guestId,renew]);
    const chat=result.rows[0];
    if(chat.chat_id===fresh){
      await db.query("UPDATE cinema_room_chats SET messages='[]'::jsonb WHERE room_id=$1",[room.id]);
      chat.messages=[];
    }
    return chat;
  });
  room.chatId=row.chat_id;
  room.messages=row.messages;
}
export async function changeChat(room,change){
  const next=await transaction(async db=>{
    const {rows:[row]}=await db.query('SELECT messages FROM cinema_room_chats WHERE room_id=$1 AND chat_id=$2 FOR UPDATE',[room.id,room.chatId]);
    if(!row)throw new HttpError(409,'Чат зала обновился. Открой комнату ещё раз.');
    const value=change(row.messages);
    const messages=row.messages.slice(-250);
    await db.query(`UPDATE cinema_room_chats SET messages=$2,expires_at=now()+${lease} WHERE room_id=$1`,[room.id,JSON.stringify(messages)]);
    return {messages,value};
  });
  room.messages=next.messages;
  return next.value;
}
export async function maintainChatLeases(activeRooms,onlineUsers){
  if(onlineUsers.length || activeRooms.length){
    // Social pages keep their account socket open while the cinema tab is away.
    await query(`UPDATE cinema_room_chats AS chat SET expires_at=now()+${lease}
      FROM cinema_rooms AS room WHERE room.id=chat.room_id
        AND (chat.room_id=ANY($1::text[]) OR (chat.expires_at>now()
          AND (room.owner_id=ANY($2::uuid[]) OR chat.guest_id=ANY($2::uuid[]))))`,
      [activeRooms,onlineUsers]);
  }
  await query('DELETE FROM cinema_room_chats WHERE expires_at<=now() AND NOT(room_id=ANY($1::text[]))',[activeRooms]);
}
