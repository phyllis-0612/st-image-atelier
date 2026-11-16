// Line icons for card buttons, keyed by the glyph each button used to show as text.
// Drawn with currentColor so they follow the button's text colour in every theme.
const PATHS = {
  '↻': '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
  '✎': '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  '⌕': '<path d="M12 4v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M5 20h14"/>',
  '▦': '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  '⋯': '<path d="M5 12h.01"/><path d="M12 12h.01"/><path d="M19 12h.01"/>',
  '×': '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  '⚙': '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8"/><path d="m16 7 3 3"/>',
  '⇩': '<path d="M12 4v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M5 20h14"/>',
  '↑': '<path d="M12 20V9"/><path d="M7.5 13.5 12 9l4.5 4.5"/><path d="M5 4h14"/>',
  '▧': '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="m4 16 5-5 4 4 3-3 4 4"/>',
  '‹': '<path d="m15 6-6 6 6 6"/>',
  '›': '<path d="m9 6 6 6-6 6"/>',
  '🗑': '<path d="M5 7h14"/><path d="M9 7V4h6v3"/><path d="m7 7 1 13h8l1-13"/>',
};

export function iconMarkup(symbol) {
  const paths = PATHS[symbol];
  if (!paths) return '';
  const width = symbol === '⋯' ? 2.6 : 2;
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="${width}" `
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}
