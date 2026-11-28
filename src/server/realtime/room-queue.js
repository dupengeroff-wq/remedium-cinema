import {HttpError} from '../http/helpers.js';

export function createRoomQueue({maxPending=100}={}) {
// Serialize joins, chat commits and film boundaries in the same room.
const roomQueues=new Map();
const pending=new Map();
function inRoomOrder(room,work){
  const count=pending.get(room.id)||0;
  if(count>=maxPending)return Promise.reject(new HttpError(429,'Комната занята. Попробуй чуть позже.'));
  pending.set(room.id,count+1);
  const previous=roomQueues.get(room.id)||Promise.resolve();
  const next=previous.catch(()=>{}).then(work);
  roomQueues.set(room.id,next);
  return next.finally(()=>{
    const left=pending.get(room.id)-1;
    if(left>0)pending.set(room.id,left);else pending.delete(room.id);
    if(roomQueues.get(room.id)===next)roomQueues.delete(room.id);
  });
}
return {roomQueues,inRoomOrder,pendingCount:id=>pending.get(id)||0};
}
