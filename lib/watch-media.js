import crypto from 'node:crypto';
import {isIP} from 'node:net';
import catalog from '../catalog-posters.json' with {type:'json'};

export const catalogPosters=catalog;

export function catalogPoster(title) {
  const key=title?.trim().toLocaleLowerCase('ru');
  return Object.hasOwn(catalog,key)?catalog[key]:null;
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

export function movieKey(source) {
  const url=new URL(source.url);
  const vk=source.type==='vk'?new URL(source.embed).searchParams:null;
  const identity=vk?`${vk.get('oid')}_${vk.get('id')}`:(source.id||url.origin+url.pathname);
  const hash=crypto.createHash('sha256').update(source.type+':'+identity).digest('hex');
  return source.type+':'+hash;
}

export function sourcePoster(source) {
  return source.type==='youtube'&&/^[\w-]{11}$/.test(source.id||'')
    ?'https://i.ytimg.com/vi/'+source.id+'/hqdefault.jpg':null;
}
