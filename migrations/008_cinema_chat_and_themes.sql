ALTER TABLE users DROP CONSTRAINT IF EXISTS users_profile_theme_check;
ALTER TABLE users ADD CONSTRAINT users_profile_theme_check CHECK (
  profile_theme IN ('none', 'hello-kitty-pink', 'cosmos', 'sakura', 'clouds', 'lavender', 'cyberpunk', 'icy-night','nefertiti','sakura-night')
);

-- One bounded, expiring transcript per active cinema. Independent of playback checkpoints.
CREATE TABLE cinema_room_chats (
  room_id text PRIMARY KEY REFERENCES cinema_rooms(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  media_id text,
  guest_id uuid REFERENCES users(id) ON DELETE SET NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL
);
CREATE INDEX cinema_room_chats_expiry ON cinema_room_chats(expires_at);
