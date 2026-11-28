CREATE TABLE IF NOT EXISTS watch_movie_details (
  movie_id text PRIMARY KEY,
  poster_url text NOT NULL,
  title text,
  release_year smallint CHECK (release_year BETWEEN 1888 AND 2200),
  revision uuid NOT NULL
);
