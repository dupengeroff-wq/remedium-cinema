ALTER TABLE watch_sessions ADD COLUMN IF NOT EXISTS source_id text;

CREATE TABLE IF NOT EXISTS watch_room_movie_details (
  room_id text NOT NULL REFERENCES cinema_rooms(id),
  movie_id text NOT NULL,
  poster_url text NOT NULL,
  title text,
  release_year smallint CHECK (release_year BETWEEN 1888 AND 2200),
  revision uuid NOT NULL,
  PRIMARY KEY (room_id,movie_id)
);
