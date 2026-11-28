-- Existing choices stay intact. The application maps retired keys when reading.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_profile_theme_check;
ALTER TABLE users ADD CONSTRAINT users_profile_theme_check CHECK (
  profile_theme IN ('none','cosmos','sakura','clouds','lavender','cyberpunk','icy-night',
                    'nefertiti','hello-kitty-pink','sakura-night','zero-two')
);
ALTER TABLE users ALTER COLUMN profile_theme SET DEFAULT 'zero-two';
