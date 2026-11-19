import crypto from 'node:crypto';
import {requireUser} from './auth.js';
import {query} from './db.js';
import {ensure,HttpError,limiter,text,uuid} from './http.js';
import {catalogPoster,knownMovieTitle,movieKey,posterUrl,providerVideoId,youtubePoster} from './watch-media.js';
import {videoDetails} from './watch-source-details.js';
import {parseMedia} from '../media.js';

export function catalogSearchAvailable() {
  return Boolean(process.env.TMDB_READ_TOKEN?.trim());
}

async function tmdb(path,params) {
  const token=process.env.TMDB_READ_TOKEN?.trim();
  ensure(token,503,'Поиск по каталогу недоступен. Можно сохранить обложку по ссылке.');
  const url=new URL('https://api.themoviedb.org/3/'+path);
  url.search=new URLSearchParams({language:'ru-RU',...params});
  try {
    const response=await fetch(url,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},
      redirect:'error',signal:AbortSignal.timeout(7000)});
    ensure(response.ok,502,'Каталог фильмов временно недоступен. Попробуй позже.');
    return await response.json();
  } catch(error) {
    if(error instanceof HttpError) throw error;
    throw new HttpError(502,'Каталог фильмов временно недоступен. Попробуй позже.');
  }
}

function catalogFilm(movie) {
  if(!Number.isSafeInteger(movie?.id)||movie.id<1||!/^\/[a-z0-9_-]+\.(?:jpg|png)$/i.test(movie.poster_path||'')) return null;
  const title=text(movie.title,120);
  if(!title) return null;
  const year=/^(\d{4})-\d\d-\d\d$/.exec(movie.release_date||'')?.[1];
  const releaseYear=Number(year);
  return {id:movie.id,title,
    release_year:releaseYear>=1888&&releaseYear<=2200?releaseYear:null,
    poster_key:'https://image.tmdb.org/t/p/w500'+movie.poster_path};
}

export async function withHistoryCovers(rows,canEdit=false) {
  const needsArchive=rows.filter(row=>!knownMovieTitle(row.movie_title) ||
    (!row.source_id && !posterUrl(row.poster_key)));
  const roomIds=[...new Set(needsArchive.map(row=>row.room_id))];
  const archive=new Map();
  if(roomIds.length){
    const {rows:rooms}=await query('SELECT id,state,history FROM cinema_rooms WHERE id=ANY($1::text[])',[roomIds]);
    for(const room of rooms){
      const entries=Array.isArray(room.history)?room.history:[];
      const matches=new Map();
      for(const item of [...entries,{url:room.state?.media?.url,title:room.state?.title,poster:room.state?.watchPoster}]){
        const source=parseMedia(item?.url);
        if(!source) continue;
        const key=movieKey(source);
        const previous=matches.get(key);
        matches.set(key,{sourceId:providerVideoId(source),
          title:knownMovieTitle(item.title)||previous?.title||'',
          poster:posterUrl(item.poster)||previous?.poster||null});
      }
      archive.set(room.id,matches);
    }
  }
  const watched=rows.map(row=>{
    const saved=archive.get(row.room_id)?.get(row.movie_id);
    const originalTitle=knownMovieTitle(row.movie_title)||saved?.title||'';
    const title=knownMovieTitle(row.selected_title)||originalTitle;
    const sourceId=row.source_id||saved?.sourceId;
    const sourcePreview=youtubePoster(row.media_type,sourceId);
    const savedPoster=posterUrl(row.poster_key)||saved?.poster;
    const customPoster=posterUrl(row.selected_poster);
    const poster=customPoster||(savedPoster!==sourcePreview&&savedPoster)||catalogPoster(originalTitle);
    return {row,title,originalTitle,sourceId,poster,customPoster};
  });
  const metadata=await videoDetails(watched);
  return watched.map(({row,title,originalTitle,sourceId,poster,customPoster})=>{
    const {room_id,source_id,selected_title,selected_poster,poster_revision,...item}=row;
    const info=metadata.get(row.media_type+':'+sourceId);
    const movie_title=title||info?.title||null;
    return {...item,movie_title,
      poster_key:poster||catalogPoster(originalTitle||info?.title)||info?.poster||youtubePoster(row.media_type,sourceId),
      ...(canEdit?{can_edit_cover:true,poster_revision,custom_poster_url:customPoster}:{}),
    };
  });
}

export function mountFilmCovers(app,io) {
  const rate=limiter(25,60000,req=>req.user.id);
  async function editableWatch(req) {
    rate(req);
    ensure(uuid(req.params.id),404,'Просмотр не найден.');
    const {rowCount}=await query(`SELECT 1 FROM watch_participants
      WHERE watch_session_id=$1 AND user_id=$2 AND credited_seconds>0 AND history_deleted_at IS NULL`,
    [req.params.id,req.user.id]);
    ensure(rowCount,404,'Просмотр не найден.');
  }
  app.get('/api/watch-history/:id/cover-search',requireUser(async (req,res)=>{
    await editableWatch(req);
    const name=text(req.query.title,120);
    ensure(name.length>=2,400,'Введи название фильма.');
    const local=catalogPoster(name);
    if(local) return res.json({films:[{title:name,poster_key:local}]});
    if(!catalogSearchAvailable()) return res.json({films:[]});
    const result=await tmdb('search/movie',{query:name,include_adult:'false'});
    const films=Array.isArray(result?.results)?result.results.map(catalogFilm).filter(Boolean).slice(0,8):[];
    res.json({films});
  }));
  app.patch('/api/watch-history/:id/cover',requireUser(async (req,res)=>{
    await editableWatch(req);
    const body=req.body||{};
    const {revision,filmId}=body;
    ensure(revision===null||uuid(revision),400,'Открой историю заново.');
    const updateCover=filmId!==undefined||Object.hasOwn(body,'poster');
    let poster=null,title=null,year=null;
    if(filmId!==undefined){
      ensure(Number.isSafeInteger(filmId)&&filmId>0,400,'Выбери фильм из результатов поиска.');
      const film=catalogFilm(await tmdb('movie/'+filmId));
      ensure(film?.id===filmId,404,'Достоверная обложка этого фильма недоступна.');
      ({poster_key:poster,title,release_year:year}=film);
    } else {
      if(updateCover){
        ensure(typeof body.poster==='string',400,'Укажи ссылку или очисти поле.');
        const address=body.poster.trim();
        poster=address?posterUrl(address):null;
        ensure(!address||poster,400,'Укажи корректную HTTPS-ссылку на обложку.');
      }
      title=text(body.title,120)||null;
    }
    ensure(updateCover||title,400,'Укажи название фильма или обложку.');
    const {rows:participants}=await query(`WITH changed AS (
      UPDATE watch_sessions w SET
        history_title=coalesce($3,history_title),
        history_release_year=CASE WHEN $3 IS NULL OR $3=history_title
          THEN coalesce($4,history_release_year) ELSE $4 END,
        history_poster_url=CASE WHEN $5 THEN $6 ELSE history_poster_url END,
        history_cover_set=history_cover_set OR $5,history_revision=$7
      WHERE w.id=$1 AND history_revision IS NOT DISTINCT FROM $8::uuid
        AND EXISTS (SELECT 1 FROM watch_participants p WHERE p.watch_session_id=w.id
          AND p.user_id=$2 AND p.credited_seconds>0 AND p.history_deleted_at IS NULL)
      RETURNING w.id
    )
    SELECT p.user_id,coalesce(s.settings->'history','true'::jsonb)='true'::jsonb
      AND s.settings->'hideProfile' IS DISTINCT FROM 'true'::jsonb AS public_history
    FROM changed JOIN watch_participants p ON p.watch_session_id=changed.id
    LEFT JOIN profile_privacy s ON s.user_id=p.user_id
    WHERE p.credited_seconds>0 AND p.history_deleted_at IS NULL`,
    [req.params.id,req.user.id,title,year,updateCover,poster,crypto.randomUUID(),revision]);
    ensure(participants.length,409,'История уже изменилась. Открой просмотр заново.');
    const rooms=participants.map(p=>'user:'+p.user_id);
    for(const p of participants) if(p.public_history) rooms.push('history-profile:'+p.user_id);
    io.to(rooms).emit('watch-history-updated',{id:req.params.id});
    res.json({ok:true});
  }));
  app.delete('/api/watch-history/:id',requireUser(async (req,res)=>{
    rate(req);
    ensure(uuid(req.params.id),404,'Просмотр не найден.');
    const {rowCount}=await query(`UPDATE watch_participants SET history_deleted_at=coalesce(history_deleted_at,now())
      WHERE watch_session_id=$1 AND user_id=$2 AND credited_seconds>0`,[req.params.id,req.user.id]);
    ensure(rowCount,404,'Просмотр не найден.');
    res.json({ok:true});
  }));
}
