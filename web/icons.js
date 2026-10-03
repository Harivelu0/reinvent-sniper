// A handful of small line icons, drawn inline so the app needs no icon library and works offline.
// They take the text colour of the button they sit in. Always pair an icon-only button with a title and an aria-label.
const PATHS = {
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/>',
  pencil: '<path d="M4 20h4L19.5 8.5l-4-4L4 16v4zM13.5 6.5l4 4"/>',
  // One icon, one meaning: x = close or dismiss, trash = remove or delete, minus = take off my calendar, pencil = edit.
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  minus: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12h8"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};

export function icon(name, size = 16) {
  const p = PATHS[name];
  if (!p) throw new Error(`Unknown icon: ${name}`);
  return `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${p}</svg>`;
}

/** A square icon-only button. `label` is both the tooltip and the accessible name. `attrs` is extra attributes such as data-* hooks. */
export function iconButton(name, label, attrs = '', extraClass = '') {
  const safe = String(label).replace(/"/g, '&quot;');
  return `<button type="button" class="iconbtn ${extraClass}" title="${safe}" aria-label="${safe}" ${attrs}>${icon(name)}</button>`;
}
