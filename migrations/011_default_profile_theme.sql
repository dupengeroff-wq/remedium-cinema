-- Only the database default changes. Existing per-user choices are untouched,
-- including historical keys and explicitly saved Zero Two.
ALTER TABLE users ALTER COLUMN profile_theme SET DEFAULT 'none';
