DO $verify$
BEGIN
  IF to_regclass('public.users') IS NULL OR to_regclass('public.direct_messages') IS NULL
     OR to_regclass('public.watch_credits') IS NULL OR to_regclass('public.cinema_rooms') IS NULL
     OR to_regclass('public.film_ratings') IS NULL OR to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Required tables are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name='012_film_ratings.sql') THEN
    RAISE EXCEPTION 'Required ratings migration is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM film_ratings r LEFT JOIN users u ON u.id=r.user_id
    WHERE u.id IS NULL OR char_length(r.movie_id) NOT BETWEEN 1 AND 256
      OR (r.score IS NOT NULL AND r.score NOT BETWEEN 1 AND 10)
      OR (r.score IS NULL AND r.share_with_partners)
  ) THEN RAISE EXCEPTION 'Invalid rating record'; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE password_hash NOT LIKE '$argon2id$%') THEN
    RAISE EXCEPTION 'Invalid password record';
  END IF;
  IF EXISTS (
    SELECT p.user_id FROM watch_participants p LEFT JOIN watch_credits c ON c.user_id=p.user_id AND c.watch_session_id=p.watch_session_id
    GROUP BY p.user_id,p.watch_session_id,p.credited_seconds HAVING p.credited_seconds<>count(c.slot)*5
  ) THEN RAISE EXCEPTION 'Watch totals differ from their ledger'; END IF;
END
$verify$;
SELECT (SELECT count(*) FROM users) AS users,
       (SELECT count(*) FROM cinema_rooms) AS rooms,
       (SELECT count(*) FROM direct_messages) AS messages,
       (SELECT count(*) FROM watch_credits) AS watch_buckets,
       (SELECT count(*) FROM film_ratings) AS rating_records,
       (SELECT count(score) FROM film_ratings) AS active_ratings;
