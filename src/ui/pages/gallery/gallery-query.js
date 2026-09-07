const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeGalleryItem(value = {}) {
  const provider = value.provider === 'novelai'
    || value.presetId === 'novelai'
    || value.artistPresetId
    ? 'novelai'
    : 'openai';
  return {
    ...value,
    provider,
    favorite: value.favorite === true,
    promptSnapshot: String(value.promptSnapshot || value.prompt || value.resolvedPrompt || ''),
  };
}

export function gallerySearchText(value) {
  const item = normalizeGalleryItem(value);
  return [
    item.promptSnapshot,
    item.prompt,
    item.resolvedPrompt,
    item.negativePromptSnapshot,
    item.resolvedNegativePrompt,
    item.apiModel,
    item.presetNameSnapshot,
    item.artistPresetNameSnapshot,
    item.artistPromptSnapshot,
    item.artistNegativePromptSnapshot,
  ].filter(Boolean).join('\n').toLocaleLowerCase();
}

function sourceKey(item) {
  if (item.provider === 'novelai' && (item.artistPresetId || item.artistPresetNameSnapshot)) {
    return `artist:${item.artistPresetId || item.artistPresetNameSnapshot}`;
  }
  return `preset:${item.presetId || item.presetNameSnapshot || ''}`;
}

function dateThreshold(period, currentTime) {
  if (period === 'today') {
    const date = new Date(currentTime);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  if (period === '7d') return currentTime - 7 * DAY_MS;
  if (period === '30d') return currentTime - 30 * DAY_MS;
  return null;
}

export function filterGalleryItems(items, filters = {}, currentTime = Date.now()) {
  const query = String(filters.query || '').trim().toLocaleLowerCase();
  const threshold = dateThreshold(filters.date, currentTime);
  return (Array.isArray(items) ? items : [])
    .map(normalizeGalleryItem)
    .filter(item => !query || gallerySearchText(item).includes(query))
    .filter(item => filters.favorite === 'favorite' ? item.favorite
      : filters.favorite === 'not-favorite' ? !item.favorite : true)
    .filter(item => !filters.provider || filters.provider === 'all' || item.provider === filters.provider)
    .filter(item => !filters.model || item.apiModel === filters.model)
    .filter(item => !filters.source || sourceKey(item) === filters.source)
    .filter(item => {
      if (threshold == null) return true;
      const created = Date.parse(item.createdAt || '');
      return Number.isFinite(created) && created >= threshold && created <= currentTime;
    })
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

export function galleryFilterOptions(items) {
  const normalized = (Array.isArray(items) ? items : []).map(normalizeGalleryItem);
  const models = [...new Set(normalized.map(item => item.apiModel).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const sources = new Map();
  for (const item of normalized) {
    if (item.provider === 'novelai' && (item.artistPresetId || item.artistPresetNameSnapshot)) {
      sources.set(sourceKey(item), `画师串：${item.artistPresetNameSnapshot || item.artistPresetId}`);
    } else if (item.presetId || item.presetNameSnapshot) {
      sources.set(sourceKey(item), `API 预设：${item.presetNameSnapshot || item.presetId}`);
    }
  }
  return {
    models,
    sources: [...sources].map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}
