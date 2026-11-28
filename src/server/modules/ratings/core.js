import {ensure,uuid,text} from '../../http/helpers.js';

// Identical to the existing profile history status contract.
export const historyStatusSql="CASE WHEN w.status='running' AND w.updated_at<now()-interval '25 seconds' THEN 'interrupted' ELSE w.status END";
export const rateableSql="("+historyStatusSql+")<>'running'";

export function ratingInput(body) {
  const score=body?.score;
  ensure(score===null || (Number.isInteger(score)&&score>=1&&score<=10),400,'Выбери целую оценку от 1 до 10.');
  ensure(body?.shareWithPartners===undefined||typeof body.shareWithPartners==='boolean',400,'Некорректная настройка оценки.');
  return {score,shareWithPartners:score!==null&&body.shareWithPartners===true};
}
export function historyFilters(input,own) {
  const status=['running','interrupted','completed'].includes(input?.status)?input.status:'all';
  const rated=own&&['rated','unrated'].includes(input?.rated)?input.rated:'all';
  return {q:text(input?.q,120),status,rated};
}
const numberOrNull=value=>value===null||value===undefined?null:Number(value);
export const personalRating=row=>({score:numberOrNull(row.score),shareWithPartners:row.score!=null&&row.share_with_partners===true});
export const ratingSummary=row=>({films:Number(row?.films??0),rated:Number(row?.rated??0),average:numberOrNull(row?.average)});

export async function saveRating(db,userId,sessionId,body) {
  ensure(uuid(sessionId),404,'Просмотр не найден.');
  const {score,shareWithPartners}=ratingInput(body);
  // Identity comes only from credited, visible history of this authenticated
  // account. Session edits, titles and rewatches cannot create another rating.
  // Lock the participant row to serialize the existing history-hide operation.
  const {rows:[row]}=await db.query(`
    WITH eligible AS (
      SELECT w.movie_id FROM watch_sessions w JOIN watch_participants p ON p.watch_session_id=w.id
      WHERE w.id=$1 AND p.user_id=$2 AND p.credited_seconds>0
        AND p.history_deleted_at IS NULL AND ${rateableSql}
      FOR UPDATE OF p
    )
    INSERT INTO film_ratings(user_id,movie_id,score,share_with_partners)
    SELECT $2,movie_id,$3,$4 FROM eligible WHERE true
    ON CONFLICT(user_id,movie_id) DO UPDATE SET
      score=EXCLUDED.score,share_with_partners=EXCLUDED.share_with_partners,updated_at=now()
    RETURNING movie_id,score,share_with_partners`,[sessionId,userId,score,shareWithPartners]);
  ensure(row,404,'Завершённый или прерванный просмотр не найден.');
  return {movieId:row.movie_id,rating:personalRating(row)};
}
export async function personalRatingSummary(db,userId) {
  const {rows:[row]}=await db.query(`
    WITH watched AS (
      SELECT DISTINCT w.movie_id FROM watch_participants p
        JOIN watch_sessions w ON w.id=p.watch_session_id
      WHERE p.user_id=$1 AND p.credited_seconds>0 AND p.history_deleted_at IS NULL AND ${rateableSql}
    )
    SELECT count(*) AS films,count(r.score) AS rated,round(avg(r.score),1) AS average
    FROM watched w LEFT JOIN film_ratings r ON r.user_id=$1 AND r.movie_id=w.movie_id`,[userId]);
  return ratingSummary(row);
}

// Ratings can be shared only with an actual co-viewer, if both independently
// opt in for this movie and both allow history/shared & stats/profile visibility.
// Never emit private or partial partner votes. Summary spans distinct films,
// not duplicated sessions/credits, and the detail map only covers requested rows.
const privacySql=alias=>`
  COALESCE(${alias}.settings->'hideProfile','false'::jsonb)='false'::jsonb
  AND COALESCE(${alias}.settings->'hideStats','false'::jsonb)='false'::jsonb
  AND COALESCE(${alias}.settings->'shared','true'::jsonb)='true'::jsonb
  AND COALESCE(${alias}.settings->'history','true'::jsonb)='true'::jsonb`;
export async function pairedRatings(db,viewer,partner,history) {
  const ids=[...new Set(history.map(row=>row.movie_id).filter(Boolean))];
  const {rows:[row]}=await db.query(`
    WITH watched AS (
      SELECT DISTINCT w.movie_id
      FROM shared_watch_intervals s JOIN watch_sessions w ON w.id=s.watch_session_id
      JOIN watch_participants a ON a.watch_session_id=w.id AND a.user_id=$1
      JOIN watch_participants b ON b.watch_session_id=w.id AND b.user_id=$2
      LEFT JOIN profile_privacy pa ON pa.user_id=$1
      LEFT JOIN profile_privacy pb ON pb.user_id=$2
      WHERE s.user_a_id=least($1::uuid,$2::uuid) AND s.user_b_id=greatest($1::uuid,$2::uuid)
        AND a.credited_seconds>0 AND b.credited_seconds>0 AND a.history_deleted_at IS NULL
        AND b.history_deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM profile_watch_exclusions e WHERE
          (e.profile_id=$1 AND e.partner_id=$2) OR (e.profile_id=$2 AND e.partner_id=$1))
        AND ${rateableSql} AND (${privacySql('pa')}) AND (${privacySql('pb')})
    ), paired AS (
      SELECT w.movie_id,a.score AS own_score,b.score AS partner_score,
             (a.score+b.score)::numeric/2 AS average
      FROM watched w
      JOIN film_ratings a ON a.user_id=$1 AND a.movie_id=w.movie_id AND a.share_with_partners AND a.score IS NOT NULL
      JOIN film_ratings b ON b.user_id=$2 AND b.movie_id=w.movie_id AND b.share_with_partners AND b.score IS NOT NULL
    )
    SELECT count(*) AS rated,round(avg(average),1) AS average,
      coalesce(jsonb_agg(jsonb_build_object('movieId',movie_id,'own',own_score,'partner',partner_score,'average',average))
        FILTER (WHERE movie_id=ANY($3::text[])),'[]'::jsonb) AS details FROM paired`,[viewer,partner,ids]);
  const ratingByMovie=new Map((row?.details||[]).map(r=>[r.movieId,{own:Number(r.own),partner:Number(r.partner),average:Number(r.average)}]));
  return {
    // The existence of unshared votes is not observable.
    pairRatingSummary:{rated:Number(row?.rated??0),average:numberOrNull(row?.average)},
    history:history.map(item=>ratingByMovie.has(item.movie_id)?{...item,pairRating:ratingByMovie.get(item.movie_id)}:item)
  };
}
