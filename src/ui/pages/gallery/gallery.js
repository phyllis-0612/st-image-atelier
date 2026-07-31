function formatDate(value) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function createGalleryPage(api) {
  const root = document.createElement('section');
  root.className = 'stia-gallery-page';
  const heading = document.createElement('div');
  heading.className = 'stia-gallery-heading';
  const title = document.createElement('strong');
  title.textContent = '▦  画廊';
  const count = document.createElement('span');
  count.textContent = '0 张';
  heading.append(title, count);
  const grid = document.createElement('div');
  grid.className = 'stia-gallery-grid';
  const empty = document.createElement('p');
  empty.className = 'stia-empty';
  empty.textContent = '还没有生成过图片。';
  const loadMore = document.createElement('button');
  loadMore.type = 'button';
  loadMore.className = 'stia-button';
  loadMore.textContent = '加载更多';
  let cursor = null;
  let loading = false;

  function detail(result) {
    const dialog = document.createElement('dialog');
    dialog.className = 'stia-detail';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'stia-icon-button';
    close.setAttribute('aria-label', '关闭详情');
    close.textContent = '×';
    close.addEventListener('click', () => dialog.close());
    const image = document.createElement('img');
    image.src = api.fileUrl(result.resultId);
    image.alt = result.prompt.slice(0, 120);
    const prompt = document.createElement('pre');
    prompt.textContent = result.prompt;
    const meta = document.createElement('p');
    meta.className = 'stia-muted';
    meta.textContent = `${result.apiModel} · ${formatDate(result.createdAt)} · ${Math.round((result.byteSize || 0) / 1024)} KB`;
    const actions = document.createElement('div');
    actions.className = 'stia-actions';
    const download = document.createElement('a');
    download.className = 'stia-button stia-button--primary';
    download.href = api.downloadUrl(result.resultId);
    download.textContent = '下载原图';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'stia-button stia-button--danger';
    remove.textContent = '删除';
    remove.addEventListener('click', async () => {
      if (!confirm('确定删除这张本地图片吗？此操作不可撤销。')) return;
      remove.disabled = true;
      try {
        await api.deleteResult(result.resultId);
        grid.querySelector(`[data-result-id="${CSS.escape(result.resultId)}"]`)?.remove();
        count.textContent = `${grid.children.length} 张`;
        dialog.close();
        if (!grid.children.length) root.append(empty);
      } catch (error) {
        alert(error.message);
        remove.disabled = false;
      }
    });
    actions.append(download, remove);
    dialog.append(close, image, meta, prompt, actions);
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.showModal();
  }

  function addCard(result) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'stia-gallery-card';
    card.dataset.resultId = result.resultId;
    const image = document.createElement('img');
    image.src = api.fileUrl(result.resultId);
    image.alt = result.prompt.slice(0, 100);
    image.loading = 'lazy';
    const caption = document.createElement('span');
    const model = document.createElement('strong');
    model.textContent = result.apiModel;
    const prompt = document.createElement('span');
    prompt.textContent = result.prompt;
    const time = document.createElement('time');
    time.dateTime = result.createdAt;
    time.textContent = formatDate(result.createdAt);
    caption.append(model, prompt, time);
    card.append(image, caption);
    card.addEventListener('click', () => detail(result));
    grid.append(card);
  }

  async function load({ reset = false } = {}) {
    if (loading) return;
    loading = true;
    loadMore.disabled = true;
    if (reset) {
      cursor = null;
      grid.replaceChildren();
      empty.remove();
    }
    try {
      const page = await api.gallery({ cursor });
      page.items.forEach(addCard);
      count.textContent = `${grid.children.length} 张`;
      cursor = page.nextCursor;
      loadMore.hidden = !cursor;
      if (!grid.children.length) root.append(empty);
    } catch (error) {
      empty.textContent = error.message;
      if (!empty.isConnected) root.append(empty);
    } finally {
      loading = false;
      loadMore.disabled = false;
    }
  }

  loadMore.addEventListener('click', () => load());
  root.append(heading, grid, loadMore);
  return { root, load };
}
