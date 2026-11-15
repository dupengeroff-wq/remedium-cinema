import crypto from 'node:crypto';
import {requireUser} from './auth.js';
import {query} from './db.js';
import {ensure,HttpError,limiter,text,uuid} from './http.js';
import {catalogPoster,movieKey,posterUrl,sourcePoster} from './watch-media.js';
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
  const history=rows.map(({room_id,selected_title,selected_poster,poster_revision,...row})=>({
    ...row,room_id,
    movie_title:selected_title||row.movie_title,
    poster_key:posterUrl(selected_poster)||posterUrl(row.poster_key)||catalogPoster(selected_title||row.movie_title),
    ...(canEdit?{poster_revision}:{}),
  }));
  const missing=history.filter(row=>!row.poster_key&&row.media_type==='youtube');
  if(missing.length){
    const ids=[...new Set(missing.map(row=>row.room_id))];
    const {rows:rooms}=await query('SELECT id,history FROM cinema_rooms WHERE id=ANY($1::text[])',[ids]);
    const byRoom=new Map(rooms.map(room=>{
      const posters=new Map();
      for(const entry of Array.isArray(room.history)?room.history:[]){
        const source=parseMedia(entry?.url);
        if(source?.type==='youtube') posters.set(movieKey(source),sourcePoster(source));
      }
      return [room.id,posters];
    }));
    for(const row of missing) row.poster_key=byRoom.get(row.room_id)?.get(row.movie_id)||null;
  }
  return history.map(({room_id,...row})=>row);
}

export function mountFilmCovers(app) {
  const rate=limiter(25,60000,req=>req.user.id);
  async function editableWatch(req) {
    ensure(req.user.role==='creator',403,'Обложки может менять только администратор.');
    rate(req);
    ensure(uuid(req.params.id),404,'Просмотр не найден.');
    const {rows:[watch]}=await query(`SELECT w.movie_id FROM watch_sessions w
      JOIN watch_participants p ON p.watch_session_id=w.id
      WHERE w.id=$1 AND p.user_id=$2 AND p.credited_seconds>0`,[req.params.id,req.user.id]);
    ensure(watch,404,'Просмотр не найден.');
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
    const values=[watch.movie_id,poster,title,year,crypto.randomUUID()];
    const sql=revision===null
      ?`INSERT INTO watch_movie_details(movie_id,poster_url,title,release_year,revision)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT(movie_id) DO NOTHING RETURNING revision`
      :`UPDATE watch_movie_details SET poster_url=$2,title=COALESCE($3,title),
          release_year=CASE WHEN $3 IS NULL OR $3=title THEN COALESCE($4,release_year) ELSE $4 END,
          revision=$5 WHERE movie_id=$1 AND revision=$6 RETURNING revision`;
    const {rowCount}=await query(sql,revision===null?values:[...values,revision]);
    ensure(rowCount,409,'Обложка уже обновилась. Открой историю заново.');
    res.json({ok:true});
  }));
}
