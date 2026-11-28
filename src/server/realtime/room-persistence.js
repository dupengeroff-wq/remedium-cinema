export function createRoomPersistence({saveRoom,snapshotRoom,isShuttingDown}) {
const dirtyRooms=new Set();
const pendingRooms=new Map();
const isPending=room=>dirtyRooms.has(room)||pendingRooms.has(room);
let saveTimer;
let writeQueue=Promise.resolve(true);
function flushSaves() {
  clearTimeout(saveTimer);
  saveTimer=null;
  if(!dirtyRooms.size) return writeQueue;
  const roomsToWrite=[...dirtyRooms];
  dirtyRooms.clear();
  for(const room of roomsToWrite)pendingRooms.set(room,(pendingRooms.get(room)||0)+1);
  writeQueue=writeQueue.then(async ()=>{
    let ok=true;
    for(const room of roomsToWrite){
      try { await saveRoom(room.id,snapshotRoom(room),room.history); }
      catch(error){
        ok=false;
        dirtyRooms.add(room);
        console.warn('Unable to save room:',error.code||error.name);
      } finally{
        const count=pendingRooms.get(room)-1;
        if(count>0)pendingRooms.set(room,count);else pendingRooms.delete(room);
      }
    }
    if(dirtyRooms.size&&!saveTimer&&!isShuttingDown()) {
      saveTimer=setTimeout(flushSaves,2000);
      saveTimer.unref();
    }
    return ok;
  });
  return writeQueue;
}
function saveSoon(room) {
  dirtyRooms.add(room);
  if(!saveTimer){
    saveTimer=setTimeout(flushSaves,400);
    saveTimer.unref();
  }
}
return {dirtyRooms,flushSaves,saveSoon,isPending};
}
