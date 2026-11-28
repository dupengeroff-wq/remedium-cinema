export {DEFAULT_THEME,profileThemes,displayTheme,themePreference} from './theme-contract.js';
export function profileCrown(user) {
  const owner = process.env.REMEDIUM_OWNER_USER_ID?.trim().toLowerCase();
  const eva = process.env.REMEDIUM_EVA_USER_ID?.trim().toLowerCase();
  if (owner ? user.id === owner : user.role === 'creator') return 'king';
  if (eva && user.id === eva) return 'queen';
  return null;
}
