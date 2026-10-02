import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMessageRenderer } from '../../src/ui/renderer/message-renderer.js';
import { createStore } from '../../src/ui/state/store.js';

for (const first of ['old', 'new']) {
  test(`并行请求 ${first} 先回图时立即显示，另一条仍可取消和重 roll`, t => {
    const { container, state, store, generated } = setup(t);
    const older = { attemptId: 'old', status: 'generating', createdAt: '2026-10-02T00:00:00Z', model: 'old-model', parameters: { size: '768x1152' } };
    const newer = { attemptId: 'new', status: 'generating', parallel: true, createdAt: '2026-10-02T00:00:01Z', model: 'new-model', parameters: { size: '1024x1024' } };
    state.attempts = [newer, older];
    state.results = [];
    state.tag.latestResultId = null;
    store.setTag('tag-1', state);
    const card = container.querySelector('.stia-card');
    assert.match(card.textContent, /2 个生成任务并行/);
    assert.equal(card.querySelectorAll('.stia-card__task').length, 2);
    const winner = first === 'old' ? older : newer;
    const loser = first === 'old' ? newer : older;
    winner.status = 'succeeded';
    state.tag.latestResultId = `result-${first}`;
    state.results.push({ resultId: `result-${first}`, attemptId: winner.attemptId, status: 'available', prompt: 'winner' });
    store.setTag('tag-1', state);
    const image = card.querySelector('img');
    assert.equal(image.getAttribute('src'), `/images/result-${first}.png`);
    assert.match(card.textContent, /仍有 1 个任务在生成/);
    assert.equal(card.querySelectorAll('.stia-card__task').length, 1);
    [...card.querySelectorAll('button')].find(item => item.textContent.includes('并行重 roll')).click();
    assert.equal(generated.length, 1);
    loser.statusMessage = '迟到图片仍在等待';
    store.setTag('tag-1', state);
    assert.equal(card.querySelector('img'), image, '其他并行任务更新不应摘下已返回的图片');
    loser.status = 'succeeded';
    state.tag.latestResultId = `result-${loser.attemptId}`;
    state.results.push({ resultId: state.tag.latestResultId, attemptId: loser.attemptId, status: 'available', prompt: 'late image' });
    store.setTag('tag-1', state);
    assert.equal(card.querySelector('img').getAttribute('src'), `/images/result-${loser.attemptId}.png`);
    assert.match(card.textContent, /历史 2 张/);
    assert.equal(card.querySelector('.stia-card__pending'), null);
    assert.equal(card.querySelector('.stia-card__size').textContent, loser.parameters.size.replace('x', '×'));
  });
}

function setup(t, html = '<p>正文之前</p><draw>cat by a window</draw><p>正文之后</p>') {
  const dom = new JSDOM('<!DOCTYPE html><div class="mes"><div class="mes_text"></div></div>', {
    url: 'http://localhost',
  });
  const globals = ['window', 'document', 'Node', 'NodeFilter', 'CSS', 'HTMLElement', 'Element', 'Range'];
  const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) globalThis[key] = key === 'window' ? dom.window : dom.window[key];
  globalThis.CSS = { escape: value => String(value).replace(/[^\w-]/g, ch => `\\${ch}`) };
  t.after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const tag = { tagId: 'tag-1', prompt: 'cat by a window', ratio: 'portrait', ordinal: 0, count: 1 };
  const store = createStore();
  const state = {
    tag: { latestResultId: 'result-1' },
    attempts: [{ attemptId: 'attempt-1', status: 'succeeded', model: 'test-model', parameters: { size: '768x1152' } }],
    results: [{ resultId: 'result-1', status: 'available', prompt: tag.prompt }],
  };
  store.setTag(tag.tagId, state);
  const generated = [];
  const adjusted = [];
  const renderer = createMessageRenderer({
    compat: { messageElement: () => dom.window.document.querySelector('.mes') },
    api: { fileUrl: id => `/images/${id}.png` },
    store,
    actions: {
      generate: (...args) => generated.push(args),
      adjustRegenerate: (...args) => adjusted.push(args),
      cancel() {}, openGallery() {}, remove() {},
    },
  });
  const container = dom.window.document.querySelector('.mes_text');
  container.innerHTML = html;
  renderer.mount('0', [tag]);
  return { dom, container, renderer, tag, state, store, generated, adjusted };
}

test('其他卡片状态、轮询和无关设置变化不修改已完成卡片的 DOM', t => {
  const { dom, container, state, store } = setup(t);
  const card = container.querySelector('.stia-card');
  const image = card.querySelector('img');
  const observer = new dom.window.MutationObserver(() => {});
  observer.observe(card, { childList: true, attributes: true, characterData: true, subtree: true });
  for (let index = 0; index < 10; index += 1) {
    store.setTag('other-tag', { attempts: [{ status: 'generating', updatedAt: index }] });
    store.setTag('tag-1', JSON.parse(JSON.stringify(state)));
  }
  store.set({ settings: { ...store.state.settings, autoGenerate: true, themeMode: 'dark' } });
  assert.equal(card.querySelector('img'), image);
  assert.deepEqual(observer.takeRecords(), [], '相同画面不应发生任何 DOM 或 src 写入');
  observer.disconnect();
});

test('历史张数和重绘按钮变化只更新文字控件，图片留在原位置且不重写 src', t => {
  const { dom, container, state, store } = setup(t);
  const card = container.querySelector('.stia-card');
  const media = card.querySelector('.stia-card__media');
  const image = card.querySelector('img');
  const details = card.querySelector('details');
  details.open = true;
  const observer = new dom.window.MutationObserver(() => {});
  observer.observe(card, { childList: true, attributes: true, subtree: true });
  state.results.push({ resultId: 'older-result', status: 'available', prompt: 'older prompt' });
  store.setTag('tag-1', state);
  store.set({ settings: { ...store.state.settings, enablePromptOverrideRegenerate: true } });
  assert.match(card.textContent, /历史 2 张/);
  assert.match(card.textContent, /调整后重绘/);
  assert.equal(card.querySelector('img'), image);
  assert.equal(card.querySelector('.stia-card__media'), media);
  assert.equal(image.isConnected, true);
  assert.equal(card.querySelector('details').open, true, '展开的提示词不应自动收起');
  const records = observer.takeRecords();
  assert.equal(records.some(record => [...record.removedNodes].includes(media) || [...record.removedNodes].includes(image)), false);
  assert.equal(records.some(record => record.target === image && record.attributeName === 'src'), false);
  observer.disconnect();
});

for (const [name, html] of [
  ['存活的 draw 元素', '<p>正文之前</p><draw>cat by a window</draw><p>正文之后</p>'],
  ['字面 draw 文本', '<p>正文之前</p><p>&lt;draw&gt;cat by a window&lt;/draw&gt;</p><p>正文之后</p>'],
  ['消毒后只剩提示词', '<p>正文之前</p><p>cat by a window</p><p>正文之后</p>'],
  ['没有可定位原文的楼底 fallback', '<p>正文之前</p><p>正文之后</p>'],
]) {
  test(`楼层重建后复用原卡片与图片：${name}`, t => {
    const { container, renderer, tag } = setup(t, html);
    const card = container.querySelector('.stia-card');
    const image = card.querySelector('img');
    container.innerHTML = html;
    renderer.mount('0', [{ ...tag }]);
    assert.equal(container.querySelector('.stia-card'), card);
    assert.equal(card.querySelector('img'), image);
    assert.equal(container.querySelectorAll('.stia-card').length, 1);
    assert.equal(container.querySelector('draw'), null);
    assert.ok(container.textContent.includes('正文之前') && container.textContent.includes('正文之后'));
  });
}

test('fallback 回到正文锚点时也复用原卡片和图片', t => {
  const { container, renderer, tag } = setup(t, '<p>正文之前</p>');
  const card = container.querySelector('.stia-card');
  const image = card.querySelector('img');
  container.insertAdjacentHTML('afterbegin', '<draw>cat by a window</draw>');
  renderer.mount('0', [tag]);
  assert.equal(container.querySelector('.stia-card'), card);
  assert.equal(card.querySelector('img'), image);
  assert.equal(container.querySelector('.stia-card-list'), null);
});

test('fallback 没有找到新锚点时不反复摘下图片或新建列表', t => {
  const { dom, container, renderer, tag } = setup(t, '<p>正文之前</p>');
  const list = container.querySelector('.stia-card-list');
  const observer = new dom.window.MutationObserver(() => {});
  observer.observe(container, { childList: true, attributes: true, characterData: true, subtree: true });
  for (let index = 0; index < 5; index += 1) renderer.mount('0', [{ ...tag }]);
  assert.equal(container.querySelector('.stia-card-list'), list);
  assert.deepEqual(observer.takeRecords(), [], '无变化的 fallback 重挂载不应产生 DOM 变动');
  observer.disconnect();
});

test('整个消息元素替换后仍复用原卡片和图片', t => {
  const { dom, renderer, tag } = setup(t);
  const oldMessage = dom.window.document.querySelector('.mes');
  const card = oldMessage.querySelector('.stia-card');
  const image = card.querySelector('img');
  const replacement = dom.window.document.createElement('div');
  replacement.className = 'mes';
  replacement.innerHTML = '<div class="mes_text"><draw>cat by a window</draw></div>';
  oldMessage.replaceWith(replacement);
  renderer.mount('0', [tag]);
  assert.equal(replacement.querySelector('.stia-card'), card);
  assert.equal(card.querySelector('img'), image);
});

test('卡片脱离 DOM 期间状态变化，重新挂载时展示最新结果与标签参数', t => {
  const { container, renderer, tag, state, store, generated } = setup(t);
  const card = container.querySelector('.stia-card');
  const oldImage = card.querySelector('img');
  container.innerHTML = '<draw>cat by a window</draw>';
  state.tag.latestResultId = 'result-2';
  state.results.push({ resultId: 'result-2', status: 'available', prompt: 'new prompt' });
  store.setTag('tag-1', state);
  const updatedTag = { ...tag, ratio: 'landscape', count: 2 };
  renderer.mount('0', [updatedTag]);
  assert.equal(container.querySelector('.stia-card'), card);
  assert.notEqual(card.querySelector('img'), oldImage);
  assert.equal(card.querySelector('img').getAttribute('src'), '/images/result-2.png');
  [...card.querySelectorAll('button')].find(button => button.textContent.includes('重新生成')).click();
  assert.equal(generated[0][0], updatedTag);
});

test('重新生成仍展示动画，取消后恢复原图片节点，成功后切换到新图', t => {
  const { container, state, store } = setup(t);
  const card = container.querySelector('.stia-card');
  const oldImage = card.querySelector('img');
  state.attempts.unshift({ attemptId: 'attempt-2', status: 'generating', requestMode: 'manual' });
  store.setTag('tag-1', state);
  assert.match(card.textContent, /正在重新生成/);
  assert.ok(card.querySelector('.stia-card__shimmer'));
  assert.equal(card.querySelector('img'), null);
  const shimmer = card.querySelector('.stia-card__shimmer');
  store.setTag('tag-1', JSON.parse(JSON.stringify(state)));
  assert.equal(card.querySelector('.stia-card__shimmer'), shimmer, '重复状态轮询不重启动画');
  state.attempts[0].status = 'cancelled';
  store.setTag('tag-1', state);
  assert.equal(card.querySelector('img'), oldImage);
  state.attempts[0].status = 'succeeded';
  state.tag.latestResultId = 'result-2';
  state.results.push({ resultId: 'result-2', status: 'available', prompt: 'second prompt' });
  store.setTag('tag-1', state);
  assert.equal(card.querySelector('img').getAttribute('src'), '/images/result-2.png');
  assert.match(card.textContent, /历史 2 张/);
});

test('同一图片元数据更新后，查看原图与调整后重绘使用最新快照且不累积事件', t => {
  const { dom, container, state, store, adjusted } = setup(t);
  store.set({ settings: { ...store.state.settings, enablePromptOverrideRegenerate: true } });
  const card = container.querySelector('.stia-card');
  const image = card.querySelector('img');
  state.results[0] = { ...state.results[0], prompt: 'updated prompt', negativePrompt: 'updated negative', provider: 'novelai' };
  for (let index = 0; index < 3; index += 1) store.setTag('tag-1', JSON.parse(JSON.stringify(state)));
  assert.equal(card.querySelector('img'), image);
  assert.equal(image.alt, 'updated prompt');
  [...card.querySelectorAll('button')].find(button => button.textContent.includes('调整后重绘')).click();
  assert.equal(adjusted.length, 1);
  assert.equal(adjusted[0][1].negativePrompt, 'updated negative');
  assert.equal(adjusted[0][1].provider, 'novelai');
  image.click();
  assert.equal(dom.window.document.querySelector('.stia-image-viewer__prompt pre').textContent, 'updated prompt');
  assert.equal(dom.window.document.querySelectorAll('.stia-image-viewer').length, 1);
  dom.window.document.querySelector('.stia-image-viewer__close').click();
});

test('仅负面词和 provider 快照更新时，跳过重绘也不会使按钮回调过期', t => {
  const { dom, container, state, store, adjusted } = setup(t);
  store.set({ settings: { ...store.state.settings, enablePromptOverrideRegenerate: true } });
  const card = container.querySelector('.stia-card');
  const observer = new dom.window.MutationObserver(() => {});
  observer.observe(card, { childList: true, attributes: true, characterData: true, subtree: true });
  const updated = JSON.parse(JSON.stringify(state));
  updated.results[0].negativePrompt = 'latest negative';
  updated.results[0].provider = 'novelai';
  store.setTag('tag-1', updated);
  assert.deepEqual(observer.takeRecords(), []);
  [...card.querySelectorAll('button')].find(button => button.textContent.includes('调整后重绘')).click();
  assert.equal(adjusted[0][1].negativePrompt, 'latest negative');
  assert.equal(adjusted[0][1].provider, 'novelai');
  observer.disconnect();
});

test('同楼多个标签重建后各自复用原卡片，不丢图、不重复且顺序正确', t => {
  const { container, renderer, tag, state, store } = setup(t);
  const second = { ...tag, tagId: 'tag-2', prompt: 'dog in a garden', ordinal: 1 };
  store.setTag('tag-2', {
    ...state,
    tag: { latestResultId: 'dog-result' },
    results: [{ resultId: 'dog-result', status: 'available', prompt: second.prompt }],
  });
  const html = '<p>正文之前</p><draw>cat by a window</draw><p>中间正文</p><draw>dog in a garden</draw><p>正文之后</p>';
  container.innerHTML = html;
  renderer.mount('0', [tag, second]);
  const cards = [...container.querySelectorAll('.stia-card')];
  const images = cards.map(card => card.querySelector('img'));
  container.innerHTML = html;
  renderer.mount('0', [tag, second]);
  assert.deepEqual([...container.querySelectorAll('.stia-card')], cards);
  assert.deepEqual([...container.querySelectorAll('.stia-card img')], images);
  assert.deepEqual([...container.children].map(node => node.matches('.stia-card') ? node.dataset.tagId : node.textContent),
    ['正文之前', 'tag-1', '中间正文', 'tag-2', '正文之后']);
});

test('移除卡片时清掉已脱离 DOM 的缓存，删除结果后也不再显示缓存图片', t => {
  const { container, renderer, tag, state, store } = setup(t);
  const oldCard = container.querySelector('.stia-card');
  container.innerHTML = '<draw>cat by a window</draw>';
  renderer.removeCard('tag-1');
  renderer.mount('0', [tag]);
  assert.notEqual(container.querySelector('.stia-card'), oldCard);
  state.results = [];
  state.tag.latestResultId = null;
  store.setTag('tag-1', state);
  assert.equal(container.querySelector('img'), null);
});
