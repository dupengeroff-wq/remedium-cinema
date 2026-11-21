export const profileThemes = new Set(['nefertiti', 'hello-kitty-pink', 'sakura-night', 'zero-two']);

export function displayTheme(value) {
  if (value === 'sakura') return 'sakura-night';
  return profileThemes.has(value) ? value : 'zero-two';
}

export function profileCrown(user) {
  const owner = process.env.REMEDIUM_OWNER_USER_ID?.trim().toLowerCase();
  const eva = process.env.REMEDIUM_EVA_USER_ID?.trim().toLowerCase();
  // The database enforces one creator, attached to a permanent user ID.
  if (owner ? user.id === owner : user.role === 'creator') return 'king';
  if (eva && user.id === eva) return 'queen';
  return null;
}
