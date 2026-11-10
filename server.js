import {parseMedia} from './media.js';
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
const HISTORY=path.join(__dirname,'cinema-history.json');
let history=[];
try{const raw=JSON.parse(fs.readFileSync(HISTORY,'utf8'));if(Array.isArray(raw))history=raw.slice(-500)}catch{}
function saveHistory(){try{const tmp=HISTORY+'.tmp';fs.writeFileSync(tmp,JSON.stringify(history));fs.renameSync(tmp,HISTORY)}catch(e){console.warn('History not saved:',e.message)}}
const BADGES=new Set(['🎀','🐈','🦊','💖','🐒']);
const REACTIONS=new Set(['🔥','🥹','😍','🤤','❤️']);
const uid=()=>crypto.randomBytes(16).toString('hex');
const clean=(s,n)=>String(s??'').trim().slice(0,n);
const persist=()=>{
  try{
    const out={};
    for(const [id,r] of rooms){out[id]={hostToken:r.hostToken,hostName:r.hostName,media:r.media,time:r.time,playing:r.playing,updated:r.updated,messages:r.messages.slice(-250),badges:r.badges,wish:r.wish||null,letters:r.letters||[],poll:r.poll||null};}
    const temp=DATA+'.tmp';fs.writeFileSync(temp,JSON.stringify(out));fs.renameSync(temp,DATA);
  }catch(e){console.error('Save failed:',e.message);}
};
try{
  if(fs.existsSync(DATA)){
    const saved=JSON.parse(fs.readFileSync(DATA,'utf8'));
    for(const [id,r] of Object.entries(saved)){
      if(!r||typeof r!=='object')continue;
      rooms.set(id,{hostToken:r.hostToken||uid(),hostName:r.hostName||'Создатель',media:r.media||null,time:Number(r.time)||0,playing:false,updated:Date.now(),messages:Array.isArray(r.messages)?r.messages.slice(-250):[],badges:r.badges&&typeof r.badges==='object'?r.badges:{},wish:r.wish||null,letters:r.letters||[],poll:r.poll||null,users:new Map()});
    }
  }
}catch(e){console.warn('Unable to read stored rooms:',e.message);}

function currentTime(r){return r.playing?r.time+(Date.now()-r.updated)/1000:r.time;}
function userList(r){return [...r.users.values()].map(u=>({id:u.id,name:u.name,isHost:u.isHost,badge:u.isHost?'👑':r.badges[u.token]||'🎀'}));}
function state(r){return {users:userList(r),hostName:r.hostName,media:r.media,time:currentTime(r),playing:r.playing,messages:r.messages,wish:r.wish||null,letters:r.letters||[],poll:r.poll||null};}
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
      r={hostToken:token,hostName:name,media:null,time:0,playing:false,updated:Date.now(),messages:[],badges:{},wish:null,letters:[],poll:null,users:new Map()};
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
    socket.emit('wish-inbox',(r.letters||[]).filter(x=>x.to===token).map(x=>({id:x.id,name:x.name,read:!!x.read,text:x.read?x.text:null,at:x.at})));
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
    r.media=m;r.time=0;r.playing=false;r.updated=Date.now();
    history.push({id:uid(),title:clean(payload?.title,120)|| (m.type==='youtube'?'YouTube':m.type==='vk'?'VK Видео':m.type==='rutube'?'Rutube':'Видео'),url:clean(payload?.url,500),at:new Date().toISOString()});
    history=history.slice(-500);saveHistory();
    io.emit('cinema-history',history.slice(-100).reverse());
    broadcast(r,socket.data.room);persist();done({ok:true});
  });
  socket.on('sync',payload=>{
    const r=getRoom(socket),u=getUser(socket);
    if(!r||!u?.isHost||!r.media)return;
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
  socket.on('get-cinema-history',()=>{if(getRoom(socket))socket.emit('cinema-history',history.slice(-100).reverse())});
  const sendInbox=(r,token)=>{
    const items=(r.letters||[]).filter(x=>x.to===token).map(x=>({id:x.id,name:x.name,read:!!x.read,text:x.read?x.text:null,at:x.at}));
    for(const [sid,u] of r.users)if(u.token===token)io.to(sid).emit('wish-inbox',items);
  };
  socket.on('wish',value=>{
    const r=getRoom(socket),u=getUser(socket);if(!r||!u)return;
    const message=clean(value,140);if(!message)return;
    const recipients=[...new Set([...r.users.values()].filter(x=>x.token!==u.token).map(x=>x.token))];
    if(!recipients.length){socket.emit('wish-error','В комнате пока нет второго участника');return}
    r.letters=r.letters||[];
    for(const token of recipients){r.letters.push({id:uid(),to:token,name:u.name,text:message,read:false,at:Date.now()});sendInbox(r,token)}
    r.letters=r.letters.slice(-200);persist();socket.emit('wish-sent');
  });
  socket.on('wish-read',id=>{
    const r=getRoom(socket),u=getUser(socket);if(!r||!u)return;
    const letter=(r.letters||[]).find(x=>x.id===id&&x.to===u.token);
    if(!letter||letter.read)return;
    letter.read=true;sendInbox(r,u.token);socket.emit('wish-opened',{name:letter.name,text:letter.text});persist();
  });
  socket.on('poll-create',values=>{
    const r=getRoom(socket),u=getUser(socket);if(!r||!u||!Array.isArray(values))return;
    const options=[...new Set(values.map(x=>clean(x,100)).filter(Boolean))].slice(0,8);
    if(options.length<2)return;
    r.poll={options,votes:{},created:Date.now()};broadcast(r,socket.data.room);persist();
  });
  socket.on('poll-vote',index=>{
    const r=getRoom(socket),u=getUser(socket);
    if(!r?.poll||!u||!Number.isInteger(index)||index<0||index>=r.poll.options.length)return;
    r.poll.votes[u.token]=index;broadcast(r,socket.data.room);persist();
  });
  socket.on('disconnect',()=>leave(socket));
});

app.get('/health',(_,res)=>res.json({ok:true,rooms:rooms.size}));
app.get(['/', '/index.html'],(_,res)=>res.sendFile(path.join(__dirname,'index.html')));
for(const asset of ['app.js','cinema-ui.js','player.css']){
  app.get('/'+asset,(_,res)=>res.sendFile(path.join(__dirname,asset)));
}
// Do not expose cinema-data.json or server-side files over HTTP.
const PORT=Number(process.env.PORT)||3000;
http.listen(PORT,'0.0.0.0',()=>console.log(`REMEDIUM CINEMA COSMOS listening on ${PORT}`));
