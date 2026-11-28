import crypto from 'node:crypto';
import {isIP} from 'node:net';
import catalog from '../../data/catalog-posters.json' with {type:'json'};

export const catalogPosters=catalog;

export function catalogPoster(title) {
  const key=title?.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('ru');
  return Object.hasOwn(catalog,key)?catalog[key]:null;
}

export function knownMovieTitle(value) {
  const title=typeof value==='string'?value.trim().slice(0,120):'';
  return title&&!/^(?:youtube|vk видео|rutube|видео)(?:\s+видео)?$/i.test(title)?title:'';
}

export function posterUrl(value) {
  if(typeof value!=='string' || value.length>1200) return null;
  if(/^posters\/[a-z0-9-]+\.webp$/i.test(value)) return value;
  try {
    const url=new URL(value);
    const host=url.hostname.replace(/^\[|\]$/g,'');
    if(url.protocol!=='https:' || url.username || url.password || url.port || isIP(host) ||
      !host.includes('.') || /\.(local|localhost|internal|test|invalid)$/i.test(host)) return null;
    return url.href;
  } catch { return null; }
}

export function providerVideoId(source) {
  if(source.type==='youtube') return source.id;
  if(source.type==='vk'){
    const vk=new URL(source.embed).searchParams;
    return `${vk.get('oid')}_${vk.get('id')}`;
  }
  return null;
}

export function movieKey(source) {
  const url=new URL(source.url);
  const identity=providerVideoId(source)||url.origin+url.pathname;
  const hash=crypto.createHash('sha256').update(source.type+':'+identity).digest('hex');
  return source.type+':'+hash;
}

export function sourcePoster(source) {
  return youtubePoster(source.type,providerVideoId(source));
}

export function youtubePoster(type,id) {
  return type==='youtube'&&/^[\w-]{11}$/.test(id||'')?'https://i.ytimg.com/vi/'+id+'/hqdefault.jpg':null;
}
