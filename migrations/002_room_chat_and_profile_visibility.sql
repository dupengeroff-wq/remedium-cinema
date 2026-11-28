-- Update factory defaults for accounts that have never saved privacy settings.
UPDATE profile_privacy AS p
SET settings = '{"watchTime":true,"films":true,"sessions":true,"shared":true,"registration":true,"history":true,"friends":true,"presence":true,"hideStats":false}'::jsonb,
    updated_at = now()
FROM users AS u
WHERE u.id = p.user_id AND p.updated_at = u.created_at
  AND p.settings = '{"watchTime":false,"films":false,"sessions":false,"shared":false,"registration":false,"history":false,"friends":false,"presence":false,"hideStats":false}'::jsonb;

-- Directional exclusions apply to the profile's shared statistics.
CREATE TABLE profile_watch_exclusions (
  profile_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, partner_id),
  CHECK (profile_id <> partner_id)
);

INSERT INTO profile_watch_exclusions (profile_id, partner_id)
SELECT profile.id, partner.id
FROM users AS profile CROSS JOIN users AS partner
WHERE profile.login = 'remedium_cavus' AND partner.login = 'stanislav';

CREATE VIEW profile_shared_watch_intervals AS
SELECT watched.*
FROM (
  SELECT user_a_id AS profile_id, user_b_id AS partner_id, watch_session_id, slot FROM shared_watch_intervals
  UNION ALL
  SELECT user_b_id AS profile_id, user_a_id AS partner_id, watch_session_id, slot FROM shared_watch_intervals
) AS watched
WHERE NOT EXISTS (
  SELECT 1 FROM profile_watch_exclusions AS hidden
  WHERE hidden.profile_id = watched.profile_id AND hidden.partner_id = watched.partner_id
);

-- Prevent legacy imports and draining app instances from persisting room chat again.
CREATE FUNCTION strip_saved_room_chat() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.state := NEW.state - 'messages';
  RETURN NEW;
END;
$$;

CREATE TRIGGER cinema_rooms_strip_chat
BEFORE INSERT OR UPDATE OF state ON cinema_rooms
FOR EACH ROW WHEN (jsonb_typeof(NEW.state) = 'object' AND NEW.state ? 'messages')
EXECUTE FUNCTION strip_saved_room_chat();

UPDATE cinema_rooms SET state = state - 'messages'
WHERE jsonb_typeof(state) = 'object' AND state ? 'messages';
