import { makeImageSaveable, openImageViewer } from '../../media/image-viewer.js';
import { filterGalleryItems, galleryFilterOptions, normalizeGalleryItem } from './gallery-query.js';

const PAGE_SIZE = 30;

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

function button(label, className = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `stia-button ${className}`.trim();
  element.textContent = label;
  return element;
}

function select(options) {
  const element = document.createElement('select');
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    element.append(option);
  }
  return element;
}

function replaceOptions(control, options) {
  const previous = control.value;
  control.replaceChildren();
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    control.append(option);
  }
  control.value = [...control.options].some(option => option.value === previous) ? previous : '';
}

function isMobileBrowser() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
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

  const tools = document.createElement('div');
  tools.className = 'stia-gallery-tools';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '搜索提示词、模型、API 预设或画师串';
  search.setAttribute('aria-label', '搜索画廊');
  const clear = button('清除搜索 / 筛选');
  const batchToggle = button('批量选择');
  tools.append(search, clear, batchToggle);

  const filtersPanel = document.createElement('details');
  filtersPanel.className = 'stia-gallery-filters';
  const filtersSummary = document.createElement('summary');
  filtersSummary.textContent = '筛选';
  const filters = document.createElement('div');
  filters.className = 'stia-gallery-filters__grid';
  const favoriteFilter = select([
    ['all', '全部收藏状态'],
    ['favorite', '仅收藏'],
    ['not-favorite', '未收藏'],
  ]);
  const providerFilter = select([
    ['all', '全部引擎'],
    ['openai', 'GPT / OpenAI'],
    ['novelai', 'NovelAI'],
  ]);
  const modelFilter = select([['', '全部模型']]);
  const sourceFilter = select([['', '全部 API 预设 / 画师串']]);
  const dateFilter = select([
    ['', '全部日期'],
    ['today', '今天'],
    ['7d', '最近 7 天'],
    ['30d', '最近 30 天'],
  ]);
  for (const control of [favoriteFilter, providerFilter, modelFilter, sourceFilter, dateFilter]) {
    control.setAttribute('aria-label', control.options[0].textContent);
    filters.append(control);
  }
  filtersPanel.append(filtersSummary, filters);

  const batchBar = document.createElement('div');
  batchBar.className = 'stia-gallery-batch';
  batchBar.hidden = true;
  const selectVisible = button('选择当前结果');
  const clearSelection = button('取消全选');
  const favoriteSelected = button('批量收藏');
  const unfavoriteSelected = button('取消收藏');
  const downloadSelected = button('批量下载');
  const deleteSelected = button('批量删除', 'stia-button--danger-soft');
  const exitBatch = button('退出批量');
  batchBar.append(selectVisible, clearSelection, favoriteSelected, unfavoriteSelected,
    downloadSelected, deleteSelected, exitBatch);

  const status = document.createElement('p');
  status.className = 'stia-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  const grid = document.createElement('div');
  grid.className = 'stia-gallery-grid';
  const empty = document.createElement('div');
  empty.className = 'stia-empty';
  const emptyText = document.createElement('p');
  const emptyClear = button('清除搜索 / 筛选');
  empty.append(emptyText, emptyClear);
  const loadMore = button('加载更多');

  let allItems = [];
  let filteredItems = [];
  let visibleCount = PAGE_SIZE;
  let loading = false;
  let batchMode = false;
  const selectedIds = new Set();

  function currentFilters() {
    return {
      query: search.value,
      favorite: favoriteFilter.value,
      provider: providerFilter.value,
      model: modelFilter.value,
      source: sourceFilter.value,
      date: dateFilter.value,
    };
  }

  function announce(message, isError = false) {
    status.hidden = !message;
    status.textContent = message || '';
    status.className = `stia-status${isError ? ' stia-error' : ''}`;
  }

  function syncFilterOptions() {
    const options = galleryFilterOptions(allItems);
    replaceOptions(modelFilter, [['', '全部模型'], ...options.models.map(value => [value, value])]);
    replaceOptions(sourceFilter, [['', '全部 API 预设 / 画师串'], ...options.sources.map(item => [item.value, item.label])]);
  }

  function promptOf(result) {
    return result.promptSnapshot || result.prompt || result.resolvedPrompt || '';
  }

  async function removeResult(result, { ask = true } = {}) {
    if (ask) {
      const warning = result.favorite
        ? '这张图片已收藏。确定仍要永久删除吗？此操作不可撤销。'
        : '确定删除这张本地图片吗？此操作不可撤销。';
      if (!confirm(warning)) return false;
    }
    await api.deleteResult(result.resultId);
    allItems = allItems.filter(item => item.resultId !== result.resultId);
    selectedIds.delete(result.resultId);
    applyFilters({ preserveSelection: true });
    return true;
  }

  function detail(result) {
    openImageViewer({
      src: api.fileUrl(result.resultId),
      alt: promptOf(result).slice(0, 120),
      filename: result.resultId,
      prompt: promptOf(result),
      meta: `${result.apiModel || '未知模型'} · ${formatDate(result.createdAt)} · ${Math.round((result.byteSize || 0) / 1024)} KB`,
      onDelete: () => removeResult(result),
    });
  }

  async function toggleFavorite(result) {
    const next = !result.favorite;
    const updated = normalizeGalleryItem(await api.setFavorite(result.resultId, next));
    const index = allItems.findIndex(item => item.resultId === result.resultId);
    if (index >= 0) allItems[index] = updated;
    applyFilters({ preserveSelection: true });
    announce(next ? '已收藏' : '已取消收藏');
  }

  function addCard(result) {
    const card = document.createElement('article');
    card.className = 'stia-gallery-card';
    card.dataset.resultId = result.resultId;
    card.classList.toggle('is-selected', selectedIds.has(result.resultId));
    const cardTools = document.createElement('div');
    cardTools.className = 'stia-gallery-card__tools';
    const favorite = button(result.favorite ? '★' : '☆', 'stia-gallery-card__favorite');
    favorite.setAttribute('aria-label', result.favorite ? '取消收藏' : '收藏');
    favorite.setAttribute('aria-pressed', String(result.favorite));
    favorite.addEventListener('click', event => {
      event.stopPropagation();
      void toggleFavorite(result).catch(error => announce(error.message, true));
    });
    cardTools.append(favorite);
    if (batchMode) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedIds.has(result.resultId);
      checkbox.setAttribute('aria-label', `选择图片 ${result.resultId}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedIds.add(result.resultId);
        else selectedIds.delete(result.resultId);
        card.classList.toggle('is-selected', checkbox.checked);
        syncBatchState();
      });
      cardTools.prepend(checkbox);
    }
    const image = document.createElement('img');
    image.src = api.fileUrl(result.resultId);
    image.alt = promptOf(result).slice(0, 100);
    image.loading = 'lazy';
    makeImageSaveable(image, () => detail(result));
    const caption = document.createElement('button');
    caption.type = 'button';
    caption.className = 'stia-gallery-card__caption';
    caption.setAttribute('aria-label', '查看这张原图');
    const model = document.createElement('strong');
    model.textContent = result.apiModel || '未知模型';
    const prompt = document.createElement('span');
    prompt.textContent = promptOf(result);
    const time = document.createElement('time');
    time.dateTime = result.createdAt;
    time.textContent = formatDate(result.createdAt);
    caption.append(model, prompt, time);
    caption.addEventListener('click', () => {
      if (!batchMode) return detail(result);
      if (selectedIds.has(result.resultId)) selectedIds.delete(result.resultId);
      else selectedIds.add(result.resultId);
      render();
    });
    card.append(cardTools, image, caption);
    grid.append(card);
  }

  function syncBatchState() {
    const amount = selectedIds.size;
    for (const control of [clearSelection, favoriteSelected, unfavoriteSelected, downloadSelected, deleteSelected]) {
      control.disabled = amount === 0;
    }
    batchToggle.textContent = batchMode ? `已选择 ${amount} 张` : '批量选择';
  }

  function render() {
    grid.replaceChildren();
    empty.remove();
    for (const result of filteredItems.slice(0, visibleCount)) addCard(result);
    count.textContent = filteredItems.length === allItems.length
      ? `${allItems.length} 张`
      : `${filteredItems.length} / ${allItems.length} 张`;
    loadMore.hidden = visibleCount >= filteredItems.length;
    if (!filteredItems.length) {
      emptyText.textContent = allItems.length
        ? '没有符合当前搜索和筛选条件的图片。'
        : '还没有生成过图片。';
      emptyClear.hidden = !allItems.length;
      root.insertBefore(empty, loadMore);
    }
    syncBatchState();
  }

  function applyFilters({ preserveSelection = false } = {}) {
    if (!preserveSelection) selectedIds.clear();
    filteredItems = filterGalleryItems(allItems, currentFilters());
    visibleCount = PAGE_SIZE;
    render();
  }

  function clearFilters() {
    search.value = '';
    favoriteFilter.value = 'all';
    providerFilter.value = 'all';
    modelFilter.value = '';
    sourceFilter.value = '';
    dateFilter.value = '';
    announce('');
    applyFilters();
  }

  async function load({ reset = false } = {}) {
    if (loading) return;
    loading = true;
    loadMore.disabled = true;
    try {
      if (reset) {
        await api.cleanupGallery().catch(error => {
          console.warn('[Image Atelier] 打开画廊时自动清理失败', error);
        });
      }
      const data = await api.galleryMetadata();
      allItems = (data.items || []).map(normalizeGalleryItem);
      syncFilterOptions();
      applyFilters();
    } catch (error) {
      announce(error.message, true);
      allItems = [];
      filteredItems = [];
      render();
    } finally {
      loading = false;
      loadMore.disabled = false;
    }
  }

  async function batchFavorite(value) {
    const ids = [...selectedIds];
    const outcomes = await Promise.allSettled(ids.map(id => api.setFavorite(id, value)));
    let success = 0;
    outcomes.forEach((outcome, index) => {
      if (outcome.status !== 'fulfilled') return;
      success += 1;
      const itemIndex = allItems.findIndex(item => item.resultId === ids[index]);
      if (itemIndex >= 0) allItems[itemIndex] = normalizeGalleryItem(outcome.value);
    });
    selectedIds.clear();
    applyFilters({ preserveSelection: true });
    announce(`${value ? '收藏' : '取消收藏'}成功 ${success} 张，失败 ${ids.length - success} 张`, success !== ids.length);
  }

  async function batchDelete() {
    const items = allItems.filter(item => selectedIds.has(item.resultId));
    if (!items.length) return;
    const favoriteCount = items.filter(item => item.favorite).length;
    const favoriteWarning = favoriteCount ? `，其中 ${favoriteCount} 张已收藏` : '';
    if (!confirm(`确定永久删除选中的 ${items.length} 张图片${favoriteWarning}吗？此操作不可撤销。`)) return;
    const outcomes = await Promise.allSettled(items.map(item => api.deleteResult(item.resultId)));
    const deleted = new Set();
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') deleted.add(items[index].resultId);
    });
    allItems = allItems.filter(item => !deleted.has(item.resultId));
    for (const id of deleted) selectedIds.delete(id);
    applyFilters({ preserveSelection: true });
    announce(`删除成功 ${deleted.size} 张，失败 ${items.length - deleted.size} 张`, deleted.size !== items.length);
  }

  function batchDownload() {
    const items = allItems.filter(item => selectedIds.has(item.resultId));
    if (!items.length) return;
    if (items.length > 1 && isMobileBrowser()) {
      announce('当前移动端浏览器通常会阻止多文件下载，请逐张点开原图后长按保存。', true);
      return;
    }
    for (const item of items) {
      const link = document.createElement('a');
      link.href = api.downloadUrl(item.resultId);
      link.download = item.resultId;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    }
    announce(`已发起 ${items.length} 张图片下载；若浏览器拦截多文件，请允许下载或改为逐张保存。`);
  }

  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applyFilters(), 120);
  });
  for (const control of [favoriteFilter, providerFilter, modelFilter, sourceFilter, dateFilter]) {
    control.addEventListener('change', () => applyFilters());
  }
  clear.addEventListener('click', clearFilters);
  emptyClear.addEventListener('click', clearFilters);
  batchToggle.addEventListener('click', () => {
    batchMode = !batchMode;
    batchBar.hidden = !batchMode;
    if (!batchMode) selectedIds.clear();
    render();
  });
  exitBatch.addEventListener('click', () => {
    batchMode = false;
    batchBar.hidden = true;
    selectedIds.clear();
    render();
  });
  selectVisible.addEventListener('click', () => {
    for (const item of filteredItems) selectedIds.add(item.resultId);
    render();
  });
  clearSelection.addEventListener('click', () => {
    selectedIds.clear();
    render();
  });
  favoriteSelected.addEventListener('click', () => {
    void batchFavorite(true).catch(error => announce(error.message || '批量收藏失败', true));
  });
  unfavoriteSelected.addEventListener('click', () => {
    void batchFavorite(false).catch(error => announce(error.message || '批量取消收藏失败', true));
  });
  deleteSelected.addEventListener('click', () => {
    void batchDelete().catch(error => announce(error.message || '批量删除失败', true));
  });
  downloadSelected.addEventListener('click', batchDownload);
  loadMore.addEventListener('click', () => {
    visibleCount += PAGE_SIZE;
    render();
  });

  root.append(heading, tools, filtersPanel, batchBar, status, grid, loadMore);
  return { root, load };
}
