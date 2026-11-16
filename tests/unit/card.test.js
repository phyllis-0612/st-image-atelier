import test from 'node:test';
import assert from 'node:assert/strict';
import { createCard } from '../../src/ui/renderer/card.js';

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach(value => this.values.add(value));
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.className = '';
    this.textContent = '';
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener() {}
}

function allElements(element) {
  return [element, ...element.children.flatMap(allElements)];
}

function renderedText(element) {
  return allElements(element).map(item => item.textContent).filter(Boolean).join(' ');
}

test('已有图片重新生成时优先显示加载动画而不是继续显示旧图', t => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new FakeElement(tagName) };
  t.after(() => { globalThis.document = previousDocument; });

  const tag = { tagId: 'tag-1', prompt: 'adult woman', ratio: 'portrait' };
  const state = {
    tag: { latestResultId: 'old-result' },
    attempts: [{
      attemptId: 'new-attempt',
      status: 'generating',
      requestMode: 'manual',
      model: 'nai-diffusion-5-full',
      parameters: { size: '512x768' },
    }],
    results: [{ resultId: 'old-result', status: 'available' }],
  };
  const card = createCard({
    tag,
    api: { fileUrl: () => '/old.png' },
    getState: () => state,
    onGenerate: () => {},
    onOpenGallery: () => {},
    onCancel: () => {},
  });
  card.render();

  assert.equal(card.root.classList.contains('stia-card--generating'), true);
  assert.match(renderedText(card.root), /正在重新生成/);
  assert.ok(allElements(card.root).some(item => item.className === 'stia-card__shimmer'));
  assert.equal(allElements(card.root).some(item => item.tagName === 'img'), false);
});

/* 一键删除按钮 —— 失败与待生成两种状态提供，生成中和已出图不提供 */
class ClickableElement extends FakeElement {
  constructor(tagName) {
    super(tagName);
    this.handlers = {};
  }

  addEventListener(type, handler) {
    this.handlers[type] = handler;
  }
}

function findButton(root, label) {
  return allElements(root).find(element =>
    element.tagName === 'button' && element.children.some(child => child.textContent === label));
}

function cardWith(state, onRemove) {
  const tag = { tagId: 'tag-1', prompt: 'adult woman', ratio: 'portrait' };
  const card = createCard({
    tag,
    api: { fileUrl: id => `/file/${id}` },
    getState: () => state,
    onGenerate: () => {},
    onOpenGallery: () => {},
    onCancel: () => {},
    onRemove,
  });
  card.render();
  return { card, tag };
}

test('失败和待生成的卡片带「删除」按钮，点击把整条标签交给 onRemove', t => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new ClickableElement(tagName) };
  t.after(() => { globalThis.document = previousDocument; });

  const removed = [];
  const failed = cardWith({ attempts: [{ status: 'failed', errorMessage: 'HTTP 451' }], results: [] }, tag => removed.push(tag));
  const failedButton = findButton(failed.card.root, '删除');
  assert.ok(failedButton, '失败卡片要有删除按钮');
  failedButton.handlers.click();
  assert.deepEqual(removed, [failed.tag]);

  const idle = cardWith({ attempts: [], results: [] }, tag => removed.push(tag));
  assert.ok(findButton(idle.card.root, '删除'), '待生成卡片要有删除按钮');
});

test('生成中和已出图的卡片不提供「删除」，没传 onRemove 时也不显示', t => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new ClickableElement(tagName) };
  t.after(() => { globalThis.document = previousDocument; });

  const generating = cardWith({ attempts: [{ status: 'generating' }], results: [] }, () => {});
  assert.equal(findButton(generating.card.root, '删除'), undefined);
  const succeeded = cardWith({
    tag: { latestResultId: 'r1' },
    attempts: [{ status: 'succeeded' }],
    results: [{ resultId: 'r1', status: 'available' }],
  }, () => {});
  assert.equal(findButton(succeeded.card.root, '删除'), undefined);
  const noHandler = cardWith({ attempts: [{ status: 'failed' }], results: [] }, undefined);
  assert.equal(findButton(noHandler.card.root, '删除'), undefined);
});

function extrasCard(state, options = {}) {
  const tag = { tagId: 'tag-1', prompt: 'adult woman', ratio: 'portrait' };
  const card = createCard({
    tag,
    api: { fileUrl: id => `/file/${id}` },
    getState: () => state,
    onGenerate: () => {},
    onOpenGallery: () => {},
    onCancel: () => {},
    ...options,
  });
  card.render();
  return card;
}

test('次要操作多于一个时收进「更多」，默认收起，点一下展开；只有一个时直接显示', t => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new ClickableElement(tagName) };
  t.after(() => { globalThis.document = previousDocument; });
  const failed = { attempts: [{ status: 'failed', errorMessage: 'HTTP 451' }], results: [] };
  const tools = { onRecover: () => {}, canRecover: () => true, onImportOriginal: () => {}, canImportOriginal: () => true };

  const full = extrasCard(failed, { ...tools, onRemove: () => {}, onOpenSettings: () => {} });
  const list = allElements(full.root).find(item => item.className === 'stia-card__more-list');
  assert.equal(list.hidden, true);
  assert.deepEqual(list.children.map(item => item.children.at(-1).textContent), ['换 Key / 预设', '找回流港图片', '导入原图', '删除']);
  const toggle = findButton(full.root, '更多');
  toggle.handlers.click();
  assert.equal(list.hidden, false);
  assert.equal(toggle.attributes.get('aria-expanded'), 'true');
  toggle.handlers.click();
  assert.equal(list.hidden, true);

  // 默认设置下没有找回和导入：待生成卡片只剩「删除」，不值得再套一层菜单。
  const single = extrasCard({ attempts: [], results: [] }, { onRemove: () => {} });
  assert.equal(findButton(single.root, '更多'), undefined);
  assert.ok(findButton(single.root, '删除'));
  const none = extrasCard({ attempts: [], results: [] });
  assert.equal(findButton(none.root, '更多'), undefined);
});

test('已出图卡片：翻页和状态同一行，尺寸并入参数行，找回与导入只在开启时出现', t => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new ClickableElement(tagName) };
  t.after(() => { globalThis.document = previousDocument; });
  const state = {
    tag: { latestResultId: 'r2', resultIds: ['r1', 'r2'] },
    attempts: [{ attemptId: 'a2', status: 'succeeded', parameters: { size: '1024x1536' } }],
    results: [
      { resultId: 'r1', status: 'available', attemptId: 'a1', parameters: { size: '1024x1536' } },
      { resultId: 'r2', status: 'available', attemptId: 'a2', parameters: { size: '1024x1536' } },
    ],
  };
  const byClass = (root, name) => allElements(root).find(item => item.className === name);
  const plain = extrasCard(state);
  const completion = byClass(plain.root, 'stia-card__completion');
  assert.deepEqual(completion.children.map(item => item.className), ['stia-card__done', 'stia-card__pagination']);
  assert.equal(byClass(plain.root, 'stia-card__metadata').children[0].className, 'stia-card__history');
  assert.equal(findButton(plain.root, '找回流港图片'), undefined);
  assert.equal(findButton(plain.root, '导入原图'), undefined);
  assert.equal(findButton(plain.root, '更多'), undefined);

  const withTools = extrasCard(state, {
    onRecover: () => {}, canRecover: () => true, onImportOriginal: () => {}, canImportOriginal: () => true,
  });
  assert.ok(findButton(withTools.root, '更多'));
  assert.ok(findButton(withTools.root, '找回流港图片'));
  assert.ok(findButton(withTools.root, '导入原图'));
});
