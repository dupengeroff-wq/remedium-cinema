import express from 'express';
import {createServer} from 'node:http';
import {Server} from 'socket.io';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const DATA=path.join(__dirname,'cinema-data.json');
const app=express();
const http=createServer(app);
const io=new Server(http,{maxHttpBufferSize:100_000});
const rooms=new Map();
const BADGES=new Set(['🎀','🐈','🦊','💖','🐒']);
const REACTIONS=new Set(['🔥','🥹','😍','🤤','❤️']);
const uid=()=>crypto.randomBytes(16).toString('hex');
const clean=(s,n)=>String(s??'').trim().slice(0,n);
const persist=()=>{
  try{
    const out={};
    for(const [id,r] of rooms){out[id]={hostToken:r.hostToken,hostName:r.hostName,media:r.media,time:r.time,playing:r.playing,updated:r.updated,messages:r.messages.slice(-250),badges:r.badges};}
    const temp=DATA+'.tmp';fs.writeFileSync(temp,JSON.stringify(out));fs.renameSync(temp,DATA);
  }catch(e){console.error('Save failed:',e.message);}
};
try{
  if(fs.existsSync(DATA)){
    const saved=JSON.parse(fs.readFileSync(DATA,'utf8'));
    for(const [id,r] of Object.entries(saved)){
      if(!r||typeof r!=='object')continue;
      rooms.set(id,{hostToken:r.hostToken||uid(),hostName:r.hostName||'Создатель',media:r.media||null,time:Number(r.time)||0,playing:false,updated:Date.now(),messages:Array.isArray(r.messages)?r.messages.slice(-250):[],badges:r.badges&&typeof r.badges==='object'?r.badges:{},users:new Map()});
    }
  }
}catch(e){console.warn('Unable to read stored rooms:',e.message);}

function parseMedia(input){
  let url;
  try{url=new URL(clean(input,2000));}catch{return null;}
  if(!['https:','http:'].includes(url.protocol))return null;
  const host=url.hostname.toLowerCase().replace(/^www\./,'');
  if(host==='youtu.be'||host==='youtube.com'||host==='m.youtube.com'||host==='youtube-nocookie.com'){
    let id=host==='youtu.be'?url.pathname.split('/')[1]:url.searchParams.get('v');
    if(!id){const m=url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);id=m?.[1];}
    if(!/^[\w-]{11}$/.test(id||''))return null;
    return {type:'youtube',id,url:url.href};
  }
  if(host==='vk.com'||host==='m.vk.com'||host==='vkvideo.ru'||host==='m.vkvideo.ru'||host==='video.vk.com'){
    const oid=url.searchParams.get('oid');const id=url.searchParams.get('id');
    let embed;
    if(oid&&id&&/^-?\d+$/.test(oid)&&/^\d+$/.test(id)){
      embed=`https://vk.com/video_ext.php?oid=${oid}&id=${id}&hd=2`;
    }else{
      const match=url.pathname.match(/video(-?\d+)_(\d+)/);
      if(match)embed=`https://vk.com/video_ext.php?oid=${match[1]}&id=${match[2]}&hd=2`;
    }
    if(!embed)return null;
    return {type:'vk',embed,url:url.href};
  }
  if(/\.(mp4|webm|ogg)(?:$|[?#])/i.test(url.href))return {type:'video',url:url.href};
  return null;
}
async function discoverTitle(m){
  if(m.type==='video'){
    try{const p=new URL(m.url).pathname.split('/').pop()||'';
      return decodeURIComponent(p).replace(/\.(mp4|webm|ogg)$/i,'').replace(/[_-]+/g,' ').slice(0,120)||null;
    }catch{return null;}
  }
  let endpoint;
  if(m.type==='youtube') endpoint='https://www.youtube.com/oembed?format=json&url='+encodeURIComponent('https://www.youtube.com/watch?v='+m.id);
  else if(m.type==='vk') endpoint='https://vk.com/oembed?url='+encodeURIComponent(m.url);
  else return null;
  try{
    const response=await fetch(endpoint,{headers:{accept:'application/json'},signal:AbortSignal.timeout(5500)});
    if(!response.ok)return null;
    const data=await response.json();
    const title=clean(data?.title,120);
    return title||null;
  }catch(e){console.info('Video title unavailable:',m.type,e.message);return null;}
}
function currentTime(r){return r.playing?r.time+(Date.now()-r.updated)/1000:r.time;}
function userList(r){return [...r.users.values()].map(u=>({id:u.id,name:u.name,isHost:u.isHost,badge:u.isHost?'👑':r.badges[u.token]||'🎀'}));}
function state(r){return {users:userList(r),hostName:r.hostName,media:r.media,time:currentTime(r),playing:r.playing,messages:r.messages};}
function broadcast(r,id){io.to(id).emit('room-state',state(r));}
function getRoom(socket){const id=socket.data.room;const r=rooms.get(id);return r?.users.get(socket.id)?r:null;}
function getUser(socket){return getRoom(socket)?.users.get(socket.id);}
function leave(socket){
  const id=socket.data.room;
  if(!id)return;
  const r=rooms.get(id);
  if(r){r.users.delete(socket.id);broadcast(r,id);}
  socket.leave(id);socket.data.room=null;
}

io.on('connection',socket=>{
  socket.on('join',(payload,ack)=>{
    const done=typeof ack==='function'?ack:()=>{};
    const id=clean(payload?.room,80),name=clean(payload?.name,24);
    if(!/^[a-zA-Z0-9_-]{3,80}$/.test(id)||!name)return done({ok:false,error:'Укажи имя и корректный код комнаты'});
    leave(socket);
    let r=rooms.get(id);
    let token=clean(payload?.token,128);
    if(!r){
      token=uid();
      r={hostToken:token,hostName:name,media:null,time:0,playing:false,updated:Date.now(),messages:[],badges:{},users:new Map()};
      rooms.set(id,r);
    }
    const isHost=token===r.hostToken;
    if(!token||token===r.hostToken&&r.users.has(socket.id))token=token||uid();
    if(!token)token=uid();
    if(isHost)r.hostName=name;
    const u={id:socket.id,name,token,isHost};
    r.users.set(socket.id,u);
    socket.data.room=id;
    socket.join(id);
    done({ok:true,id:socket.id,token,isHost});
    broadcast(r,id);
    persist();
  });
  socket.on('media',(payload,ack)=>{
    const done=typeof ack==='function'?ack:()=>{};
    const r=getRoom(socket),u=getUser(socket);
    if(!r||!u?.isHost)return done({error:'Менять фильм может только создатель'});
    const m=parseMedia(payload?.url);
    if(!m)return done({error:'Поддерживаются ссылки YouTube, VK Видео и прямые MP4/WebM'});
    m.title=m.type==='vk'?'Видео VK':m.type==='youtube'?'Видео YouTube':'Видео';
    r.media=m;r.time=0;r.playing=false;r.updated=Date.now();
    broadcast(r,socket.data.room);persist();done({ok:true});
    const selectedMedia=m;
    discoverTitle(m).then(title=>{
      if(!title||r.media!==selectedMedia)return;
      selectedMedia.title=title;
      broadcast(r,socket.data.room);persist();
    }).catch(e=>console.warn('Title lookup failed:',e.message));
  });
  socket.on('sync',payload=>{
    const r=getRoom(socket),u=getUser(socket);
    if(!r||!u||!r.media)return;
    const t=Number(payload?.time);
    if(!Number.isFinite(t)||t<0||t>86400*12)return;
    r.time=t;r.playing=!!payload.playing;r.updated=Date.now();
    socket.to(socket.data.room).emit('sync',{time:r.time,playing:r.playing});
    persist();
  });
  socket.on('request-sync',()=>{
    const r=getRoom(socket);if(r)socket.emit('sync',{time:currentTime(r),playing:r.playing});
  });
  socket.on('chat',input=>{
    const r=getRoom(socket),u=getUser(socket);
    if(!r||!u)return;
    const value=typeof input==='string'?input:input?.text;
    const text=clean(value,1000);
    if(!text)return;
    const msg={id:uid(),name:u.name,author:u.token,isHost:u.isHost,badge:u.isHost?'👑':r.badges[u.token]||'🎀',text,at:Date.now(),reactions:{}};
    r.messages.push(msg);if(r.messages.length>250)r.messages.shift();
    io.to(socket.data.room).emit('chat',msg);persist();
  });
  socket.on('set-badge',(badge,ack)=>{
    const done=typeof ack==='function'?ack:()=>{};
    const r=getRoom(socket),u=getUser(socket);
    if(!r||!u||u.isHost)return done({ok:false,error:'Значок выбирает гость'});
    if(!BADGES.has(badge))return done({ok:false,error:'Недоступный значок'});
    r.badges[u.token]=badge;
    for(const m of r.messages)if(m.author===u.token&&!m.isHost)m.badge=badge;
    broadcast(r,socket.data.room);persist();done({ok:true});
  });
  socket.on('react',(payload,ack)=>{
    const done=typeof ack==='function'?ack:()=>{};
    const r=getRoom(socket),u=getUser(socket);
    if(!r||!u)return done({ok:false});
    const emoji=payload?.emoji;
    if(!REACTIONS.has(emoji))return done({ok:false});
    const m=r.messages.find(x=>x.id===payload?.id);
    if(!m)return done({ok:false});
    m.reactions=m.reactions||{};
    // One reaction per participant per message. Clicking the same reaction removes it.
    const previous=Object.entries(m.reactions).find(([,users])=>Array.isArray(users)&&users.includes(u.token))?.[0];
    if(previous)m.reactions[previous]=m.reactions[previous].filter(x=>x!==u.token);
    if(previous!==emoji){m.reactions[emoji]=m.reactions[emoji]||[];m.reactions[emoji].push(u.token);}
    io.to(socket.data.room).emit('reaction-update',{id:m.id,reactions:m.reactions});
    persist();done({ok:true});
  });
  socket.on('disconnect',()=>leave(socket));
});

app.get('/health',(_,res)=>res.json({ok:true,rooms:rooms.size}));
app.get(['/', '/index.html'],(_,res)=>res.sendFile(path.join(__dirname,'index.html')));
// Do not expose cinema-data.json or server-side files over HTTP.
const PORT=Number(process.env.PORT)||3000;
http.listen(PORT,'0.0.0.0',()=>console.log(`REMEDIUM CINEMA COSMOS listening on ${PORT}`));
