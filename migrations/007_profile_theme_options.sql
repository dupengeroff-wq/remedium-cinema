ALTER TABLE users DROP CONSTRAINT IF EXISTS users_profile_theme_check;
ALTER TABLE users ADD CONSTRAINT users_profile_theme_check CHECK (
  profile_theme IN ('none', 'hello-kitty-pink', 'cosmos', 'sakura', 'clouds', 'lavender', 'cyberpunk', 'icy-night')
);
