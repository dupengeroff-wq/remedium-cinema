CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  login text NOT NULL UNIQUE,
  nickname text NOT NULL,
  password_hash text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  friend_code text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member','creator')),
  avatar_key text,
  bio text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_one_creator ON users(role) WHERE role='creator';

CREATE TABLE IF NOT EXISTS profile_privacy (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  user_agent text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  PRIMARY KEY (user_id,code_hash)
);

CREATE TABLE IF NOT EXISTS friendships (
  user_a_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending','accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  PRIMARY KEY (user_a_id,user_b_id),
  CHECK (user_a_id < user_b_id AND requester_id IN (user_a_id,user_b_id)),
  CHECK ((status='accepted') = (accepted_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS friendships_b_idx ON friendships(user_b_id,status);

CREATE TABLE IF NOT EXISTS cinema_rooms (
  id text PRIMARY KEY,
  owner_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  guest_id uuid REFERENCES users(id) ON DELETE SET NULL,
  invite_hash text,
  invite_for uuid REFERENCES users(id) ON DELETE CASCADE,
  invite_expires_at timestamptz,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (owner_id IS DISTINCT FROM guest_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  user_a_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_a_id,user_b_id),
  CHECK (user_a_id < user_b_id)
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id bigint NOT NULL DEFAULT 0,
  hidden_at timestamptz,
  PRIMARY KEY (conversation_id,user_id)
);
CREATE INDEX IF NOT EXISTS conversation_members_user_idx ON conversation_members(user_id,conversation_id);
CREATE TABLE IF NOT EXISTS direct_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  client_id uuid NOT NULL,
  body text NOT NULL CHECK (char_length(body) <= 2000),
  room_id text,
  invite_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (conversation_id,sender_id,client_id),
  FOREIGN KEY (conversation_id,sender_id) REFERENCES conversation_members(conversation_id,user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS direct_messages_conversation_idx ON direct_messages(conversation_id,id DESC);

CREATE TABLE IF NOT EXISTS watch_sessions (
  id uuid PRIMARY KEY,
  room_id text NOT NULL REFERENCES cinema_rooms(id) ON DELETE RESTRICT,
  movie_id text NOT NULL,
  movie_title text NOT NULL,
  media_type text NOT NULL,
  poster_key text,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ended_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','interrupted','completed'))
);
CREATE TABLE IF NOT EXISTS watch_participants (
  watch_session_id uuid NOT NULL REFERENCES watch_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credited_seconds integer NOT NULL DEFAULT 0 CHECK (credited_seconds >= 0),
  PRIMARY KEY (watch_session_id,user_id)
);
CREATE INDEX IF NOT EXISTS watch_participants_user_idx ON watch_participants(user_id,watch_session_id);
CREATE TABLE IF NOT EXISTS watch_credits (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot bigint NOT NULL,
  watch_session_id uuid NOT NULL REFERENCES watch_sessions(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,slot)
);
CREATE INDEX IF NOT EXISTS watch_credits_session_idx ON watch_credits(watch_session_id,slot);
CREATE TABLE IF NOT EXISTS shared_watch_intervals (
  watch_session_id uuid NOT NULL REFERENCES watch_sessions(id) ON DELETE CASCADE,
  user_a_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot bigint NOT NULL,
  PRIMARY KEY(user_a_id,user_b_id,slot),
  CHECK (user_a_id < user_b_id)
);
CREATE INDEX IF NOT EXISTS shared_watch_b_idx ON shared_watch_intervals(user_b_id,user_a_id,slot DESC);
