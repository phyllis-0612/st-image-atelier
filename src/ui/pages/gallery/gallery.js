import { makeImageSaveable, openImageViewer } from '../../media/image-viewer.js';

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
    openImageViewer({
      src: api.fileUrl(result.resultId),
      alt: result.prompt.slice(0, 120),
      filename: result.resultId,
      prompt: result.prompt,
      meta: `${result.apiModel} · ${formatDate(result.createdAt)} · ${Math.round((result.byteSize || 0) / 1024)} KB`,
      onDelete: async () => {
        if (!confirm('确定删除这张本地图片吗？此操作不可撤销。')) return false;
        await api.deleteResult(result.resultId);
        grid.querySelector(`[data-result-id="${CSS.escape(result.resultId)}"]`)?.remove();
        count.textContent = `${grid.children.length} 张`;
        if (!grid.children.length) root.append(empty);
        return true;
      },
    });
  }

  function addCard(result) {
    const card = document.createElement('article');
    card.className = 'stia-gallery-card';
    card.dataset.resultId = result.resultId;
    const image = document.createElement('img');
    image.src = api.fileUrl(result.resultId);
    image.alt = result.prompt.slice(0, 100);
    image.loading = 'lazy';
    makeImageSaveable(image, () => detail(result));
    const caption = document.createElement('button');
    caption.type = 'button';
    caption.className = 'stia-gallery-card__caption';
    caption.setAttribute('aria-label', '查看这张原图');
    const model = document.createElement('strong');
    model.textContent = result.apiModel;
    const prompt = document.createElement('span');
    prompt.textContent = result.prompt;
    const time = document.createElement('time');
    time.dateTime = result.createdAt;
    time.textContent = formatDate(result.createdAt);
    caption.append(model, prompt, time);
    card.append(image, caption);
    caption.addEventListener('click', () => detail(result));
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
      if (reset) {
        await api.cleanupGallery().catch(error => {
          console.warn('[Image Atelier] 打开画廊时自动清理失败', error);
        });
      }
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
