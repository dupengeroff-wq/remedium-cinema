ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_theme text NOT NULL DEFAULT 'none'
  CHECK (profile_theme IN ('none', 'hello-kitty-pink'));
