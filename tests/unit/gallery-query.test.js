import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  filterGalleryItems,
  galleryFilterOptions,
  normalizeGalleryItem,
} from '../../src/ui/pages/gallery/gallery-query.js';
import { createGalleryPage } from '../../src/ui/pages/gallery/gallery.js';

const NOW = Date.parse('2026-09-07T12:00:00.000Z');

function item(overrides = {}) {
  return {
    resultId: overrides.resultId || crypto.randomUUID(),
    status: 'available',
    createdAt: '2026-09-07T08:00:00.000Z',
    promptSnapshot: 'cat in sunlight',
    apiModel: 'gpt-image-1',
    presetId: 'main',
    presetNameSnapshot: '主站 API',
    provider: 'openai',
    favorite: false,
    ...overrides,
  };
}

test('旧画廊数据补齐收藏与提示词快照默认值', () => {
  const normalized = normalizeGalleryItem({
    resultId: 'old',
    prompt: 'legacy prompt',
    presetId: 'novelai',
  });
  assert.equal(normalized.favorite, false);
  assert.equal(normalized.promptSnapshot, 'legacy prompt');
  assert.equal(normalized.provider, 'novelai');
});

test('搜索和多个筛选条件组合生效，缺字段与空结果不报错', () => {
  const values = [
    item({ resultId: 'cat', favorite: true }),
    item({
      resultId: 'nai',
      promptSnapshot: '1girl, moon',
      apiModel: 'nai-diffusion-4-5-full',
      provider: 'novelai',
      presetId: 'novelai',
      artistPresetId: 'soft',
      artistPresetNameSnapshot: '柔光画师串',
      artistPromptSnapshot: 'artist:sample, watercolor',
      favorite: true,
    }),
    item({
      resultId: 'old',
      promptSnapshot: 'old cat',
      createdAt: '2026-08-01T00:00:00.000Z',
    }),
    { resultId: 'missing-fields', status: 'available' },
  ];
  assert.deepEqual(filterGalleryItems(values, {
    query: 'WATERCOLOR',
    favorite: 'favorite',
    provider: 'novelai',
    model: 'nai-diffusion-4-5-full',
    source: 'artist:soft',
    date: '7d',
  }, NOW).map(value => value.resultId), ['nai']);
  assert.deepEqual(filterGalleryItems(values, { query: 'not-found' }, NOW), []);
  const options = galleryFilterOptions(values);
  assert.ok(options.models.includes('gpt-image-1'));
  assert.ok(options.sources.some(value => value.label === '画师串：柔光画师串'));
  assert.ok(options.sources.some(value => value.label === 'API 预设：主站 API'));
});

test('批量收藏、取消收藏和删除只作用于当前筛选后选中的项目', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://tavern.example/',
  });
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    navigator: globalThis.navigator,
    confirm: globalThis.confirm,
  };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.confirm = () => true;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator });
    globalThis.confirm = previous.confirm;
    dom.window.close();
  });

  const values = [
    item({ resultId: 'cat-1', promptSnapshot: 'cat one' }),
    item({ resultId: 'cat-2', promptSnapshot: 'cat two' }),
    item({ resultId: 'dog', promptSnapshot: 'dog' }),
  ];
  const favoriteCalls = [];
  const deleteCalls = [];
  const api = {
    cleanupGallery: async () => ({}),
    galleryMetadata: async () => ({ items: structuredClone(values), total: values.length }),
    fileUrl: id => `/images/${id}.png`,
    downloadUrl: id => `/download/${id}`,
    setFavorite: async (id, favorite) => {
      favoriteCalls.push([id, favorite]);
      return { ...values.find(value => value.resultId === id), favorite };
    },
    deleteResult: async id => { deleteCalls.push(id); },
  };
  const page = createGalleryPage(api);
  document.body.append(page.root);
  await page.load();

  const buttons = () => [...page.root.querySelectorAll('button')];
  const click = label => buttons().find(value => value.textContent === label).click();
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const search = page.root.querySelector('input[type="search"]');
  search.value = 'cat';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 150));
  click('批量选择');
  click('选择当前结果');
  click('批量收藏');
  await settle();
  assert.deepEqual(favoriteCalls, [['cat-1', true], ['cat-2', true]]);

  click('选择当前结果');
  click('取消收藏');
  await settle();
  assert.deepEqual(favoriteCalls.slice(2), [['cat-1', false], ['cat-2', false]]);

  click('选择当前结果');
  click('批量删除');
  await settle();
  assert.deepEqual(deleteCalls, ['cat-1', 'cat-2']);
  assert.equal(deleteCalls.includes('dog'), false);
});
