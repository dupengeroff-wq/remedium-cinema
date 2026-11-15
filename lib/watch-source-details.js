import {knownMovieTitle,posterUrl} from './watch-media.js';

const metadataCache=new Map();
const maxNewLookups=12;
const cacheTtl=5*60*1000;

async function lookup(url,options) {
  const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(1800)});
  return response.ok?response.json():null;
}

async function youtubeDetails(id) {
  const url=new URL('https://www.youtube.com/oembed');
  url.search=new URLSearchParams({url:'https://www.youtube.com/watch?v='+id,format:'json'});
  const data=await lookup(url);
  return data?.type==='video'?{title:knownMovieTitle(data.title)}:null;
}

async function vkDetails(id,token) {
  const body=new URLSearchParams({videos:id,access_token:token,v:'5.199'});
  const data=await lookup('https://api.vk.com/method/video.get',{method:'POST',body});
  const video=data?.response?.items?.find(item=>item.owner_id+'_'+item.id===id);
  if(!video||video.is_private||video.can_view===0)return null;
  const images=Array.isArray(video.image)?video.image:[];
  const poster=images.slice().sort((a,b)=>b.width-a.width).map(image=>posterUrl(image.url)).find(Boolean);
  return {title:knownMovieTitle(video.title),poster};
}

export async function videoDetails(watched) {
  const token=process.env.VK_VIDEO_READ_TOKEN?.trim();
  const requests=new Map();
  let started=0;
  for(const {row,title,sourceId,poster} of watched){
    const type=row.media_type;
    const validYouTube=type==='youtube'&&/^[\w-]{11}$/.test(sourceId||'');
    const validVk=type==='vk'&&token&&/^-?\d{1,16}_\d{1,16}$/.test(sourceId||'');
    if((title&&(poster||validYouTube))||(!validYouTube&&!validVk))continue;
    const key=type+':'+sourceId;
    if(requests.has(key))continue;
    let entry=metadataCache.get(key);
    const now=Date.now();
    if(!entry||entry.expires<=now){
      if(started>=maxNewLookups)continue;
      started++;
      const load=validYouTube?youtubeDetails(sourceId):vkDetails(sourceId,token);
      entry={value:load.catch(()=>null),expires:now+cacheTtl};
      metadataCache.delete(key);
      metadataCache.set(key,entry);
      if(metadataCache.size>240)metadataCache.delete(metadataCache.keys().next().value);
    }
    requests.set(key,entry.value);
  }
  return new Map(await Promise.all([...requests].map(async ([key,pending])=>[key,await pending])));
}
