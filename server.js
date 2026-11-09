import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const app=express();const server=createServer(app);const io=new Server(server,{pingTimeout:60000});
const rooms=new Map(),file=path.join(dir,'cinema-data.json');
const token=()=>randomBytes(24).toString('hex');
function parseMedia(raw){try{const u=new URL(String(raw||'').trim());if(!['https:','http:'].includes(u.protocol))return null;const h=u.hostname.toLowerCase();let id=null;if(h==='youtu.be')id=u.pathname.split('/')[1];if(['youtube.com','www.youtube.com','m.youtube.com'].includes(h))id=u.searchParams.get('v')||u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1];if(id&&/^[\w-]{11}$/.test(id))return{type:'youtube',id,url:'https://www.youtube.com/watch?v='+id};if(['vk.com','www.vk.com','m.vk.com','vkvideo.ru','www.vkvideo.ru','m.vkvideo.ru'].includes(h)){const m=u.pathname.match(/video(-?\d+)_(\d+)/);const oid=m?.[1]||u.searchParams.get('oid'),vid=m?.[2]||u.searchParams.get('id');if(oid&&vid&&/^-?\d+$/.test(oid)&&/^\d+$/.test(vid)){const e=new URL('https://vk.com/video_ext.php');e.searchParams.set('oid',oid);e.searchParams.set('id',vid);e.searchParams.set('js_api','1');if(u.searchParams.get('hash'))e.searchParams.set('hash',u.searchParams.get('hash'));return{type:'vk',url:u.origin+u.pathname,embed:e.href}}}if(/\.(mp4|webm)$/i.test(u.pathname))return{type:'video',url:u.href};return null}catch{return null}}
function clock(r){return r.playing?r.time+Math.max(0,(Date.now()-r.updated)/1000):r.time}
function save(){const o={};for(const[id,r]of rooms)o[id]={media:r.media,playing:false,time:clock(r),messages:r.messages.slice(-150),hostToken:r.hostToken,hostName:r.hostName,credentials:[...r.credentials]};try{fs.writeFileSync(file+'.tmp',JSON.stringify(o));fs.renameSync(file+'.tmp',file)}catch(e){console.error('Save failed:',e.message)}}
try{if(fs.existsSync(file)){const data=JSON.parse(fs.readFileSync(file,'utf8'));for(const[id,r]of Object.entries(data)){if(!/^[a-zA-Z0-9_-]{4,80}$/.test(id))continue;rooms.set(id,{media:r.media||null,playing:false,time:Number(r.time)||0,updated:Date.now(),messages:Array.isArray(r.messages)?r.messages.slice(-150):[],hostToken:r.hostToken||token(),hostName:r.hostName||'Создатель',credentials:new Map(r.credentials||[]),users:new Map()})}}}catch(e){console.error('Load failed',e.message)}
const snapshot=r=>({media:r.media,playing:r.playing,time:clock(r),hostName:r.hostName,messages:r.messages,users:[...r.users.values()].map(u=>({id:u.id,name:u.name,isHost:u.token===r.hostToken}))});
const emit=id=>{const r=rooms.get(id);if(r)io.to(id).emit('room-state',snapshot(r))};
function leave(s){const id=s.data.room;if(!id)return;const r=rooms.get(id);s.leave(id);s.data.room=null;if(!r)return;r.users.delete(s.id);if(!r.users.size){r.time=clock(r);r.playing=false;r.updated=Date.now();save()}emit(id)}
const get=s=>rooms.get(s.data.room),host=(s,r)=>!!r&&!!s.data.token&&s.data.token===r.hostToken;
io.on('connection',s=>{
 s.on('join',(d={},ack=()=>{})=>{const id=String(d.room||'').trim(),name=String(d.name||'Гость').trim().slice(0,24)||'Гость';if(!/^[a-zA-Z0-9_-]{4,80}$/.test(id))return ack({error:'Неверный код комнаты'});leave(s);let r=rooms.get(id);const created=!r;if(!r){r={media:null,playing:false,time:0,updated:Date.now(),messages:[],hostToken:'',hostName:name,credentials:new Map(),users:new Map()};rooms.set(id,r)}const requested=String(d.token||'');const t=requested&&r.credentials.has(requested)?requested:token();r.credentials.set(t,name);if(created){r.hostToken=t;r.hostName=name}if(t===r.hostToken)r.hostName=name;s.join(id);s.data.room=id;s.data.name=name;s.data.token=t;r.users.set(s.id,{id:s.id,name,token:t});ack({ok:true,id:s.id,token:t,isHost:host(s,r)});emit(id);save()});
 s.on('media',(d={},ack=()=>{})=>{const r=get(s);if(!r)return ack({error:'Сначала войдите в комнату'});if(!host(s,r))return ack({error:'Только создатель управляет фильмом'});const m=parseMedia(d.url);if(!m)return ack({error:'Поддерживаются YouTube, VK Видео и прямые MP4/WebM'});r.media=m;r.time=0;r.playing=false;r.updated=Date.now();ack({ok:true});emit(s.data.room);save()});
 s.on('sync',d=>{const r=get(s);if(!r?.media||!host(s,r))return;const time=Number(d?.time);if(!Number.isFinite(time)||time<0||time>10000000||typeof d?.playing!=='boolean')return;r.time=time;r.playing=d.playing;r.updated=Date.now();s.to(s.data.room).emit('sync',{time,playing:r.playing});save()});
 s.on('request-sync',()=>{const r=get(s);if(r?.media)s.emit('sync',{time:clock(r),playing:r.playing})});
 s.on('chat',value=>{const r=get(s);if(!r)return;const message=String(value??'').trim().slice(0,1000);if(!message)return;const msg={id:token().slice(0,12),sender:s.id,name:s.data.name||'Гость',text:message,at:Date.now()};r.messages.push(msg);if(r.messages.length>150)r.messages.shift();io.to(s.data.room).emit('chat',msg);save()});
 s.on('disconnect',()=>leave(s));
});
app.get('/health',(_,res)=>res.json({ok:true}));app.get('/',(_,res)=>res.sendFile(path.join(dir,'index.html')));app.get('/index.html',(_,res)=>res.sendFile(path.join(dir,'index.html')));
setInterval(save,30000);process.on('SIGTERM',()=>{save();process.exit(0)});server.listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('REMEDIUM CINEMA ready'));
