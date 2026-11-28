-- Stage 8: additive. No backfill or change to watch/user/history rows.
-- movie_id is the existing canonical source identity from watch_sessions.
CREATE TABLE IF NOT EXISTS film_ratings (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id text NOT NULL CHECK (char_length(movie_id) BETWEEN 1 AND 256),
  score smallint CHECK (score BETWEEN 1 AND 10),
  share_with_partners boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,movie_id),
  CHECK (score IS NOT NULL OR share_with_partners=false)
);
