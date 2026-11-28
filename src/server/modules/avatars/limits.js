// Bound the response while reading; do not allocate the entire remote response
// before validating the maximum size. No storage credentials handled here.
export async function readBodyLimited(response,maxBytes){
  const value=response.headers?.get('content-length');
  const declared=value&&/^\d+$/.test(value)?Number(value):null;
  if(declared!==null&&declared>maxBytes){
    await response.body?.cancel().catch(()=>{});
    throw new Error('Avatar response exceeds limit');
  }
  if(!response.body)throw new Error('Missing avatar response body');
  const reader=response.body.getReader();
  let total=0;const parts=[];
  try{
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      if(total+value.byteLength>maxBytes)throw new Error('Avatar response exceeds limit');
      total+=value.byteLength;
      parts.push(Buffer.from(value.buffer,value.byteOffset,value.byteLength));
    }
    if(!total)throw new Error('Empty avatar response');
    return Buffer.concat(parts,total);
  }catch(error){await reader.cancel().catch(()=>{});throw error}
  finally{reader.releaseLock()}
}
export function createWorkLimit(max){
  let running=0;
  return {
    enter(){
      if(running>=max)return null;
      running++;let done=false;
      return ()=>{if(!done){done=true;running--}};
    },
    count:()=>running
  };
}
