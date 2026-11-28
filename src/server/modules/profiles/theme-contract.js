// Persisted keys and available visual styles are separate contracts.
// Legacy keys remain valid in storage and through old clients; unsupported styles
// have a deterministic display fallback without modifying the persisted preference.
export const DEFAULT_THEME = 'none';
export const themeChoices = Object.freeze({
  none:'Default',
  nefertiti:'Нефертити',
  'hello-kitty-pink':'Hello Kitty',
  'sakura-night':'Сакура',
  'zero-two':'Zero Two (002)'
});
export const legacyDisplay = Object.freeze({
  cosmos:DEFAULT_THEME, sakura:'sakura-night', clouds:DEFAULT_THEME,
  lavender:DEFAULT_THEME, cyberpunk:DEFAULT_THEME, 'icy-night':DEFAULT_THEME
});
export const profileThemes = new Set([...Object.keys(themeChoices),...Object.keys(legacyDisplay)]);
export function displayTheme(value) {
  if(typeof value!=='string') return DEFAULT_THEME;
  if(Object.hasOwn(themeChoices,value)) return value;
  return Object.hasOwn(legacyDisplay,value)?legacyDisplay[value]:DEFAULT_THEME;
}
export function themePreference(value) {
  return {theme:displayTheme(value),themeKey:typeof value==='string'?value:DEFAULT_THEME};
}
export const browserThemeContract=Object.freeze({defaultTheme:DEFAULT_THEME,choices:themeChoices,legacyDisplay});
