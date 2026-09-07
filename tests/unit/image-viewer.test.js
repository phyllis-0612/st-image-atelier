import test from 'node:test';
import assert from 'node:assert/strict';
import { makeImageSaveable, openImageViewer } from '../../src/ui/media/image-viewer.js';

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach(value => this.values.add(value));
  }

  remove(...values) {
    values.forEach(value => this.values.delete(value));
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.style = { overflow: '' };
    this.textContent = '';
    this.className = '';
    this.disabled = false;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  prepend(...children) {
    for (const child of children.reverse()) {
      child.parentElement = this;
      this.children.unshift(child);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener({ target: this, ...event });
  }

  focus() {
    this.focused = true;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
}

function fakeEnvironment() {
  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');
  const previousFocus = new FakeElement('button');
  const document = {
    body,
    documentElement,
    activeElement: previousFocus,
    createElement: tagName => new FakeElement(tagName),
  };
  const listeners = new Map();
  const previousState = { page: 'chat' };
  const history = {
    state: previousState,
    backCalls: 0,
    pushState(state) {
      this.state = state;
    },
    back() {
      this.backCalls += 1;
      this.state = previousState;
    },
  };
  const window = {
    history,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch(type, event = {}) {
      listeners.get(type)?.(event);
    },
  };
  return { document, window, navigator: {}, previousFocus };
}

test('原图查看器始终提供关闭按钮，关闭后返回聊天历史状态', () => {
  const environment = fakeEnvironment();
  const viewer = openImageViewer({ src: '/user/images/a.png', alt: '测试图片' }, environment);
  const toolbar = viewer.root.children[0];
  const close = toolbar.children[1];

  assert.equal(viewer.root.attributes.get('role'), 'dialog');
  assert.equal(close.attributes.get('aria-label'), '关闭原图并返回酒馆页面');
  assert.equal(environment.document.body.style.overflow, 'hidden');
  assert.equal(environment.document.body.children.includes(viewer.root), true);

  close.dispatch('click');
  assert.equal(environment.document.body.children.includes(viewer.root), false);
  assert.equal(environment.window.history.backCalls, 1);
  assert.equal(environment.document.body.style.overflow, '');
  assert.equal(environment.previousFocus.focused, true);
});

test('手机返回事件关闭查看器，图片没有拦截长按菜单', () => {
  const environment = fakeEnvironment();
  const image = new FakeElement('img');
  let opens = 0;
  makeImageSaveable(image, () => { opens += 1; });
  assert.equal(image.classList.contains('stia-saveable-image'), true);
  assert.equal(image.listeners.has('contextmenu'), false);
  assert.equal(image.listeners.has('touchstart'), false);
  image.dispatch('click');
  assert.equal(opens, 1);

  const viewer = openImageViewer({ src: '/user/images/b.png' }, environment);
  environment.window.dispatch('popstate');
  assert.equal(environment.document.body.children.includes(viewer.root), false);
  assert.equal(environment.window.history.backCalls, 0);
});
