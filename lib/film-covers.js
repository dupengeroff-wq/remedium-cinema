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

export async function withHistoryCovers(rows,viewer=null) {
  const needsArchive=rows.filter(row=>!knownMovieTitle(row.selected_title||row.movie_title) ||
    (!row.source_id && !posterUrl(row.selected_poster||row.poster_key)));
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
    const title=knownMovieTitle(row.selected_title||row.movie_title)||saved?.title||'';
    const sourceId=row.source_id||saved?.sourceId;
    const sourcePreview=youtubePoster(row.media_type,sourceId);
    const savedPoster=posterUrl(row.poster_key)||saved?.poster;
    const poster=posterUrl(row.selected_poster)||(savedPoster!==sourcePreview&&savedPoster)||catalogPoster(title);
    return {row,title,sourceId,poster};
  });
  const metadata=await videoDetails(watched);
  return watched.map(({row,title,sourceId,poster})=>{
    const {room_id,source_id,room_owner_id,selected_title,selected_poster,poster_revision,...item}=row;
    const info=metadata.get(row.media_type+':'+sourceId);
    const movie_title=title||info?.title||null;
    const canEdit=Boolean(viewer&&viewer===room_owner_id);
    return {...item,movie_title,
      poster_key:poster||catalogPoster(movie_title)||info?.poster||youtubePoster(row.media_type,sourceId),
      ...(canEdit?{can_edit_cover:true,poster_revision}:{}),
    };
  });
}

export function mountFilmCovers(app) {
  const rate=limiter(25,60000,req=>req.user.id);
  async function editableWatch(req) {
    rate(req);
    ensure(uuid(req.params.id),404,'Просмотр не найден.');
    const {rows:[watch]}=await query(`SELECT w.movie_id,w.room_id,c.owner_id FROM watch_sessions w
      JOIN watch_participants p ON p.watch_session_id=w.id
      JOIN cinema_rooms c ON c.id=w.room_id
      WHERE w.id=$1 AND p.user_id=$2 AND p.credited_seconds>0`,[req.params.id,req.user.id]);
    ensure(watch,404,'Просмотр не найден.');
    ensure(watch.owner_id===req.user.id,403,'Обложку может менять владелец комнаты.');
    return watch;
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
    const watch=await editableWatch(req);
    const {revision,filmId}=req.body||{};
    ensure(revision===null||uuid(revision),400,'Открой историю заново.');
    let poster,title,year;
    if(filmId!==undefined){
      ensure(Number.isSafeInteger(filmId)&&filmId>0,400,'Выбери фильм из результатов поиска.');
      const film=catalogFilm(await tmdb('movie/'+filmId));
      ensure(film?.id===filmId,404,'Достоверная обложка этого фильма недоступна.');
      ({poster_key:poster,title,release_year:year}=film);
    } else {
      poster=posterUrl(req.body?.poster);
      ensure(poster,400,'Укажи корректную HTTPS-ссылку на обложку.');
      title=text(req.body?.title,120)||null;
      year=null;
    }
    const values=[watch.room_id,watch.movie_id,poster,title,year,crypto.randomUUID()];
    const sql=revision===null
      ?`INSERT INTO watch_room_movie_details(room_id,movie_id,poster_url,title,release_year,revision)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(room_id,movie_id) DO NOTHING RETURNING revision`
      :`UPDATE watch_room_movie_details SET poster_url=$3,title=COALESCE($4,title),
          release_year=CASE WHEN $4 IS NULL OR $4=title THEN COALESCE($5,release_year) ELSE $5 END,
          revision=$6 WHERE room_id=$1 AND movie_id=$2 AND revision=$7 RETURNING revision`;
    const {rowCount}=await query(sql,revision===null?values:[...values,revision]);
    ensure(rowCount,409,'Обложка уже обновилась. Открой историю заново.');
    res.json({ok:true});
  }));
}
