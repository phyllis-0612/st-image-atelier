const HISTORY_KEY = 'stImageAtelierViewer';
let activeViewer = null;

function extensionForMime(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function safeFilename(value, extension) {
  const base = String(value || 'image-atelier')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'image-atelier';
  return `${base}.${extension}`;
}

function createButton(documentRef, label, className, handler) {
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

export function makeImageSaveable(image, onOpen) {
  image.classList.add('stia-saveable-image');
  image.draggable = true;
  if (typeof onOpen !== 'function') return image;
  image.tabIndex = 0;
  image.setAttribute('role', 'button');
  image.setAttribute('aria-label', '查看原图；手机可长按图片保存');
  image.addEventListener('click', onOpen);
  image.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpen();
  });
  return image;
}

export function openImageViewer(options, environment = {}) {
  const documentRef = environment.document || globalThis.document;
  const windowRef = environment.window || globalThis.window;
  const navigatorRef = environment.navigator || globalThis.navigator;
  const fetchRef = environment.fetch || globalThis.fetch;
  const FileRef = environment.File || globalThis.File;
  if (!documentRef?.body) throw new Error('当前页面无法打开原图查看器');

  activeViewer?.destroy();

  const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const previousFocus = documentRef.activeElement;
  const previousBodyOverflow = documentRef.body.style.overflow;
  const previousRootOverflow = documentRef.documentElement?.style?.overflow || '';
  let closed = false;
  let historyPushed = false;

  const overlay = documentRef.createElement('section');
  overlay.className = 'stia-image-viewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '查看原图');

  const toolbar = documentRef.createElement('header');
  toolbar.className = 'stia-image-viewer__toolbar';
  const title = documentRef.createElement('strong');
  title.textContent = '查看原图';
  const close = createButton(
    documentRef,
    '× 关闭',
    'stia-image-viewer__close',
    () => requestClose(),
  );
  close.setAttribute('aria-label', '关闭原图并返回酒馆页面');
  toolbar.append(title, close);

  const stage = documentRef.createElement('div');
  stage.className = 'stia-image-viewer__stage';
  const image = documentRef.createElement('img');
  image.className = 'stia-image-viewer__image stia-saveable-image';
  image.src = options.src;
  image.alt = options.alt || '生成图片原图';
  image.draggable = true;
  stage.append(image);

  const footer = documentRef.createElement('footer');
  footer.className = 'stia-image-viewer__footer';
  const hint = documentRef.createElement('strong');
  hint.className = 'stia-image-viewer__hint';
  hint.textContent = '手机请长按图片保存';
  const status = documentRef.createElement('p');
  status.className = 'stia-image-viewer__status';
  status.setAttribute('role', 'status');
  if (options.meta) {
    const meta = documentRef.createElement('p');
    meta.className = 'stia-image-viewer__meta';
    meta.textContent = options.meta;
    footer.append(meta);
  }
  if (options.prompt) {
    const details = documentRef.createElement('details');
    details.className = 'stia-image-viewer__prompt';
    const summary = documentRef.createElement('summary');
    summary.textContent = '查看提示词';
    const prompt = documentRef.createElement('pre');
    prompt.textContent = options.prompt;
    details.append(summary, prompt);
    footer.append(details);
  }

  const actions = documentRef.createElement('div');
  actions.className = 'stia-image-viewer__actions';
  if (typeof navigatorRef?.share === 'function' && typeof FileRef === 'function' && typeof fetchRef === 'function') {
    const share = createButton(documentRef, '分享 / 保存', 'stia-button stia-button--primary', async () => {
      share.disabled = true;
      status.textContent = '正在准备原图…';
      try {
        const response = await fetchRef(options.src, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const file = new FileRef(
          [blob],
          safeFilename(options.filename, extensionForMime(blob.type)),
          { type: blob.type || 'image/png' },
        );
        const payload = { files: [file], title: 'Image Atelier 原图' };
        if (typeof navigatorRef.canShare === 'function' && !navigatorRef.canShare(payload)) {
          throw new Error('当前浏览器不支持分享图片文件');
        }
        await navigatorRef.share(payload);
        status.textContent = '';
      } catch (error) {
        if (error?.name !== 'AbortError') {
          status.textContent = '系统分享不可用，请长按图片保存。';
        }
      } finally {
        share.disabled = false;
      }
    });
    actions.append(share);
  }
  if (typeof options.onDelete === 'function') {
    const remove = createButton(documentRef, '删除', 'stia-button stia-button--danger', async () => {
      remove.disabled = true;
      try {
        const deleted = await options.onDelete();
        if (deleted !== false) requestClose();
      } catch (error) {
        status.textContent = error?.message || '删除失败';
      } finally {
        remove.disabled = false;
      }
    });
    actions.append(remove);
  }
  const footerClose = createButton(
    documentRef,
    '关闭并返回酒馆',
    'stia-button stia-button--ghost',
    () => requestClose(),
  );
  actions.append(footerClose);
  footer.prepend(hint);
  footer.append(status, actions);
  overlay.append(toolbar, stage, footer);

  function destroy() {
    if (closed) return;
    closed = true;
    windowRef?.removeEventListener?.('keydown', onKeydown);
    windowRef?.removeEventListener?.('popstate', onPopState);
    overlay.remove();
    documentRef.body.classList.remove('stia-image-viewer-open');
    documentRef.body.style.overflow = previousBodyOverflow;
    if (documentRef.documentElement?.style) {
      documentRef.documentElement.style.overflow = previousRootOverflow;
    }
    previousFocus?.focus?.();
    if (activeViewer?.token === token) activeViewer = null;
    options.onClose?.();
  }

  function requestClose() {
    if (closed) return;
    const shouldReturn = historyPushed && windowRef?.history?.state?.[HISTORY_KEY] === token;
    destroy();
    if (shouldReturn) windowRef.history.back();
  }

  function onKeydown(event) {
    if (event.key === 'Escape') requestClose();
  }

  function onPopState() {
    destroy();
  }

  stage.addEventListener('click', event => {
    if (event.target === stage) requestClose();
  });
  windowRef?.addEventListener?.('keydown', onKeydown);
  windowRef?.addEventListener?.('popstate', onPopState);
  documentRef.body.classList.add('stia-image-viewer-open');
  documentRef.body.style.overflow = 'hidden';
  if (documentRef.documentElement?.style) documentRef.documentElement.style.overflow = 'hidden';
  documentRef.body.append(overlay);
  close.focus?.();

  try {
    windowRef?.history?.pushState?.({ ...(windowRef.history.state || {}), [HISTORY_KEY]: token }, '');
    historyPushed = windowRef?.history?.state?.[HISTORY_KEY] === token;
  } catch {
    historyPushed = false;
  }

  const controller = { token, root: overlay, image, close: requestClose, destroy };
  activeViewer = controller;
  return controller;
}
