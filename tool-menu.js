export const TOOL_MENU_ENTRY_ID = 'stia-open';

function createEntry(root, onOpen) {
  const entry = root.createElement('div');
  entry.id = TOOL_MENU_ENTRY_ID;
  entry.className = 'list-group-item flex-container flexGap5 interactable';
  entry.tabIndex = 0;
  entry.setAttribute('role', 'button');
  entry.setAttribute('aria-label', '打开 Image Atelier');
  entry.setAttribute('title', '打开 Image Atelier');

  const icon = root.createElement('i');
  icon.className = 'fa-solid fa-wand-magic-sparkles';
  icon.setAttribute('aria-hidden', 'true');

  const label = root.createElement('span');
  label.textContent = 'Image Atelier';

  const activate = event => {
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    event.preventDefault?.();
    onOpen();
  };
  entry.addEventListener('click', activate);
  entry.addEventListener('keydown', activate);
  entry.append(icon, label);
  return entry;
}

export function mountToolMenuEntry({ root = document, onOpen }) {
  const menu = root.getElementById('extensionsMenu');
  if (!menu) return null;

  let entry = root.getElementById(TOOL_MENU_ENTRY_ID);
  if (!entry) entry = createEntry(root, onOpen);
  if (entry.parentElement !== menu) menu.append(entry);
  return entry;
}

export function installToolMenuEntry({
  root = document,
  onOpen,
  Observer = globalThis.MutationObserver,
}) {
  const entry = mountToolMenuEntry({ root, onOpen });
  if (entry || !Observer) return { entry, disconnect() {} };

  const observer = new Observer(() => {
    if (mountToolMenuEntry({ root, onOpen })) observer.disconnect();
  });
  observer.observe(root.documentElement || root.body, { childList: true, subtree: true });
  return { entry: null, disconnect: () => observer.disconnect() };
}
