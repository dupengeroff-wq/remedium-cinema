-- The edit belongs to one viewing session. A repeat of the same film has its own metadata.
ALTER TABLE watch_sessions
  ADD COLUMN history_title text,
  ADD COLUMN history_release_year smallint CHECK (history_release_year BETWEEN 1888 AND 2200),
  ADD COLUMN history_poster_url text,
  ADD COLUMN history_cover_set boolean NOT NULL DEFAULT false,
  ADD COLUMN history_revision uuid;

-- Older releases kept edits on individual participant rows, without an edit timestamp.
-- Choose title/year and cover separately. Prefer the room owner's explicit choice,
-- then use a stable participant order. Keep the original rows and deletion flags.
WITH edited AS (
  SELECT p.*,p.user_id=r.owner_id AS is_owner
  FROM watch_participants p
  JOIN watch_sessions w ON w.id=p.watch_session_id
  JOIN cinema_rooms r ON r.id=w.room_id
  WHERE p.history_deleted_at IS NULL AND p.credited_seconds>0
    AND (p.history_title IS NOT NULL OR p.history_cover_set)
), titles AS (
  SELECT DISTINCT ON (watch_session_id) watch_session_id,history_title,history_release_year
  FROM edited WHERE history_title IS NOT NULL
  ORDER BY watch_session_id,is_owner DESC,user_id
), covers AS (
  SELECT DISTINCT ON (watch_session_id) watch_session_id,history_poster_url
  FROM edited WHERE history_cover_set
  ORDER BY watch_session_id,is_owner DESC,user_id
)
UPDATE watch_sessions w SET
  history_title=t.history_title,history_release_year=t.history_release_year,
  history_poster_url=c.history_poster_url,history_cover_set=c.watch_session_id IS NOT NULL,
  history_revision=gen_random_uuid()
FROM titles t FULL JOIN covers c USING(watch_session_id)
WHERE w.id=coalesce(t.watch_session_id,c.watch_session_id);
