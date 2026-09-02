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
