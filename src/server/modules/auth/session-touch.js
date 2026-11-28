// Best-effort touch is not an authentication cache: every authorization still
// reads the session and its validity. Coalesce simultaneous touches only.
export function createSessionTouch(query,{limit=200,intervalMs=600000,now=Date.now}={}){
  const pending=new Map();
  function touch(row){
    if(!row||!(now()-new Date(row.last_seen_at).getTime()>intervalMs))return;
    const id=row.session_id;
    if(pending.has(id)||pending.size>=limit)return;
    const request=Promise.resolve().then(()=>query(`UPDATE auth_sessions SET last_seen_at=now()
      WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()
      AND last_seen_at<now()-interval '10 minutes'`,[id])).catch(()=>{}).finally(()=>{
      if(pending.get(id)===request)pending.delete(id);
    });
    pending.set(id,request);
  }
  return {touch,pendingCount:()=>pending.size};
}
