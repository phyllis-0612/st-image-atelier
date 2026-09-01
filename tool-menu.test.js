import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installToolMenuEntry,
  mountToolMenuEntry,
  TOOL_MENU_ENTRY_ID,
} from '../../src/ui/menu/tool-menu.js';

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.tabIndex = -1;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  append(...children) {
    for (const child of children) {
      if (child.parentElement) {
        child.parentElement.children = child.parentElement.children.filter(item => item !== child);
      }
      child.parentElement = this;
      this.children.push(child);
    }
  }

  fire(type, key) {
    this.listeners.get(type)?.({ type, key, preventDefault() {} });
  }
}

function fakeDocument() {
  const extensionsMenu = new FakeElement();
  extensionsMenu.id = 'extensionsMenu';
  const extensionsSettings = new FakeElement();
  extensionsSettings.id = 'extensions_settings';
  const roots = [extensionsSettings, extensionsMenu];
  const find = id => {
    const queue = [...roots];
    while (queue.length) {
      const current = queue.shift();
      if (current.id === id) return current;
      queue.push(...current.children);
    }
    return null;
  };
  return {
    extensionsMenu,
    extensionsSettings,
    roots,
    root: {
      createElement: tagName => new FakeElement(tagName),
      getElementById: find,
      documentElement: new FakeElement('html'),
    },
  };
}

test('入口只挂载到左下角魔法棒菜单并可打开面板', () => {
  const doc = fakeDocument();
  let opened = 0;
  const entry = mountToolMenuEntry({
    root: doc.root,
    onOpen: () => { opened += 1; },
  });

  assert.equal(entry.id, TOOL_MENU_ENTRY_ID);
  assert.equal(entry.parentElement, doc.extensionsMenu);
  assert.equal(doc.extensionsSettings.children.length, 0);
  assert.match(entry.className, /list-group-item/);
  assert.equal(entry.children[0].className, 'fa-solid fa-wand-magic-sparkles');
  assert.equal(entry.children[1].textContent, 'Image Atelier');

  entry.fire('click');
  entry.fire('keydown', 'Escape');
  entry.fire('keydown', 'Enter');
  assert.equal(opened, 2);
});

test('旧入口若误装到扩展设置页会被移动到魔法棒菜单', () => {
  const doc = fakeDocument();
  const misplaced = new FakeElement();
  misplaced.id = TOOL_MENU_ENTRY_ID;
  doc.extensionsSettings.append(misplaced);

  const entry = mountToolMenuEntry({ root: doc.root, onOpen() {} });
  assert.equal(entry, misplaced);
  assert.equal(entry.parentElement, doc.extensionsMenu);
  assert.equal(doc.extensionsSettings.children.length, 0);
});

test('魔法棒菜单稍后加载时会自动补挂载入口', () => {
  const doc = fakeDocument();
  doc.roots.pop();
  let observer;
  class FakeObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observer = this;
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  const result = installToolMenuEntry({
    root: doc.root,
    onOpen() {},
    Observer: FakeObserver,
  });
  assert.equal(result.entry, null);
  assert.equal(observer.target, doc.root.documentElement);
  assert.deepEqual(observer.options, { childList: true, subtree: true });

  doc.roots.push(doc.extensionsMenu);
  observer.callback();
  assert.equal(doc.extensionsMenu.children[0].id, TOOL_MENU_ENTRY_ID);
  assert.equal(observer.disconnected, true);
});
