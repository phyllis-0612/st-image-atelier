export const THEME_MODES = Object.freeze(['tavern', 'light', 'dark']);

export const THEME_PALETTES = Object.freeze({
  light: Object.freeze({ input: '#ffffff', inputText: '#261f24' }),
  dark: Object.freeze({ input: '#111318', inputText: '#f4f4f6' }),
});

export function normalizeThemeMode(value) {
  return THEME_MODES.includes(value) ? value : 'tavern';
}

export function applyThemeMode(value, root = globalThis.document?.documentElement) {
  const mode = normalizeThemeMode(value);
  if (root?.dataset) root.dataset.stiaTheme = mode;
  return mode;
}
