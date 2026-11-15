ALTER TABLE watch_participants
  ADD COLUMN IF NOT EXISTS history_title text,
  ADD COLUMN IF NOT EXISTS history_poster_url text,
  ADD COLUMN IF NOT EXISTS history_cover_set boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS history_release_year smallint CHECK (history_release_year BETWEEN 1888 AND 2200),
  ADD COLUMN IF NOT EXISTS history_revision uuid,
  ADD COLUMN IF NOT EXISTS history_deleted_at timestamptz;
