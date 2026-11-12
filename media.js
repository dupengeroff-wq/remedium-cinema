// Parse supported video links without dropping VK embed access hashes.
export function parseMedia(input){
  if(typeof input!=='string'||input.length>4000)return null;
  let url;
  try{url=new URL(input.trim())}catch{return null}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return null;
  const host=url.hostname.toLowerCase().replace(/^www\./,'');
  if(['youtu.be','youtube.com','m.youtube.com','youtube-nocookie.com'].includes(host)){
    let id=host==='youtu.be'?url.pathname.split('/')[1]:url.searchParams.get('v');
    if(!id)id=url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})(?:\/|$)/)?.[1];
    if(!/^[\w-]{11}$/.test(id||''))return null;
    return {type:'youtube',id,url:url.href};
  }
  if(['vk.com','m.vk.com','vkvideo.ru','m.vkvideo.ru','video.vk.com'].includes(host)){
    let oid=url.searchParams.get('oid'),id=url.searchParams.get('id');
    if(!/^-?\d+$/.test(oid||'')||!/^\d+$/.test(id||'')){
      const match=(url.pathname+' '+(url.searchParams.get('z')||'')).match(/(?:^|[\s/])video(-?\d+)_(\d+)(?=$|[/?\s])/);
      if(!match)return null;
      [,oid,id]=match;
    }
    const embed=new URL('https://vk.com/video_ext.php');
    embed.searchParams.set('oid',oid);embed.searchParams.set('id',id);
    embed.searchParams.set('hd','2');embed.searchParams.set('js_api','1');
    const hash=url.searchParams.get('hash');
    if(hash)embed.searchParams.set('hash',hash);
    return {type:'vk',embed:embed.href,url:url.href};
  }
  if(url.protocol==='https:'&&/\.(mp4|webm|ogg)$/i.test(url.pathname))return {type:'video',url:url.href};
  return null;
}
