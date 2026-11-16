export const THEME_MODES = Object.freeze(['tavern', 'light', 'dark']);

export const THEME_PALETTES = Object.freeze({
  light: Object.freeze({ input: '#ffffff', inputText: '#16211e' }),
  dark: Object.freeze({ input: '#0d1112', inputText: '#e9eeec' }),
});

export function normalizeThemeMode(value) {
  return THEME_MODES.includes(value) ? value : 'tavern';
}

export function applyThemeMode(value, root = globalThis.document?.documentElement) {
  const mode = normalizeThemeMode(value);
  if (root?.dataset) root.dataset.stiaTheme = mode;
  return mode;
}
