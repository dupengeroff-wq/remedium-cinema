import express from 'express';
import {createServer} from 'node:http';
import {Server} from 'socket.io';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const app=express();const http=createServer(app);const io=new Server(http,{maxHttpBufferSize:100000});
const here=path.dirname(fileURLToPath(import.meta.url));
app.get('/',(_,res)=>res.sendFile(path.join(here,'index.html')));
app.get('/index.html',(_,res)=>res.sendFile(path.join(here,'index.html')));
const rooms=new Map();
const validId=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{6,32}$/.test(s);
const clean=s=>String(s??'').trim().slice(0,500);
function state(r){return {media:r.media,playing:r.playing,time:r.time,updated:r.updated,users:[...r.users.values()].map(u=>({id:u.id,name:u.name})),messages:r.messages.slice(-100)}}
function broadcast(id){const r=rooms.get(id);if(r)io.to(id).emit('room-state',state(r))}
io.on('connection',socket=>{
 socket.on('join',({room,name},reply)=>{if(!validId(room))return reply?.({error:'Неверный код комнаты'});let r=rooms.get(room);if(!r){r={media:null,playing:false,time:0,updated:Date.now(),users:new Map(),messages:[]};rooms.set(room,r)}if(r.users.size>=12)return reply?.({error:'Комната заполнена'});if(socket.data.room){socket.leave(socket.data.room);const prev=rooms.get(socket.data.room);prev?.users.delete(socket.id);broadcast(socket.data.room)}const user={id:socket.id,name:clean(name).slice(0,24)||'Гость'};r.users.set(socket.id,user);socket.data.room=room;socket.join(room);reply?.({ok:true,id:socket.id});broadcast(room)});
 socket.on('media',({url},reply)=>{const room=socket.data.room,r=rooms.get(room);if(!r)return;const media=parseMedia(url);if(!media)return reply?.({error:'Поддерживаются YouTube, VK Видео и прямые HTTPS-ссылки на MP4/WebM'});r.media=media;r.time=0;r.playing=false;r.updated=Date.now();broadcast(room);reply?.({ok:true})});
 socket.on('sync',data=>{const r=rooms.get(socket.data.room);if(!r||!r.users.has(socket.id))return;const time=Number(data?.time);if(!Number.isFinite(time)||time<0||time>864000)return;r.time=time;r.playing=!!data.playing;r.updated=Date.now();socket.to(socket.data.room).emit('sync',{time,playing:r.playing,origin:socket.id,updated:r.updated})});
 socket.on('request-sync',()=>{const r=rooms.get(socket.data.room);if(r)socket.emit('sync',{time:r.time+(r.playing?(Date.now()-r.updated)/1000:0),playing:r.playing,updated:Date.now()})});
 socket.on('chat',msg=>{const r=rooms.get(socket.data.room);if(!r||!r.users.has(socket.id))return;const text=clean(msg).slice(0,1000);if(!text)return;const user=r.users.get(socket.id);const item={id:randomBytes(8).toString('hex'),name:user.name,text,at:Date.now(),sender:socket.id};r.messages.push(item);if(r.messages.length>100)r.messages.shift();io.to(socket.data.room).emit('chat',item)});
 socket.on('disconnect',()=>{const room=socket.data.room,r=rooms.get(room);if(!r)return;r.users.delete(socket.id);broadcast(room);if(!r.users.size)setTimeout(()=>{if(!r.users.size)rooms.delete(room)},3600000)})
});
function parseMedia(value){try{const u=new URL(String(value));if(u.protocol!=='https:')return null;const h=u.hostname.toLowerCase();let id=null;if(['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(h)){if(u.pathname==='/watch')id=u.searchParams.get('v');else if(u.pathname.startsWith('/shorts/')||u.pathname.startsWith('/embed/')||u.pathname.startsWith('/live/'))id=u.pathname.split('/')[2]}else if(h==='youtu.be'||h==='www.youtu.be')id=u.pathname.slice(1).split('/')[0];if(id&&/^[\w-]{11}$/.test(id))return {type:'youtube',id,url:'https://www.youtube.com/watch?v='+id};const vkHosts=['vkvideo.ru','m.vkvideo.ru','www.vkvideo.ru','vk.com','m.vk.com','www.vk.com','vk.ru','m.vk.ru'];if(vkHosts.includes(h)){let match=u.pathname.match(/^\/video(-?\d+)_(\d+)/);let oid=match?.[1],vid=match?.[2];if(u.pathname==='/video_ext.php'){oid=u.searchParams.get('oid');vid=u.searchParams.get('id')}if(oid&&vid&&/^-?\d+$/.test(oid)&&/^\d+$/.test(vid)){const hash=u.searchParams.get('hash');const embed=new URL('https://vkvideo.ru/video_ext.php');embed.searchParams.set('oid',oid);embed.searchParams.set('id',vid);if(hash&&/^[a-zA-Z0-9_-]{1,128}$/.test(hash))embed.searchParams.set('hash',hash);embed.searchParams.set('js_api','1');return {type:'vk',url:'https://vkvideo.ru/video'+oid+'_'+vid,embed:embed.href}}}if(/\.(mp4|webm)$/i.test(u.pathname))return {type:'video',url:u.href};return null}catch{return null}}
app.get('/health',(_,res)=>res.json({ok:true}));
const port=process.env.PORT||3000;http.listen(port,()=>console.log(`REMEDIUM CINEMA on ${port}`));
