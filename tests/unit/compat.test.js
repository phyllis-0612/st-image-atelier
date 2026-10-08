import test from 'node:test';
import assert from 'node:assert/strict';
import { createStCompat } from '../../src/ui/compat/st-api.js';
import { createMessageEvents } from '../../src/ui/events/message-events.js';

test('生图通知使用酒馆原生横幅并转义上游错误文本', () => {
  let args;
  const compat = createStCompat({ toastr: { error: (...values) => { args = values; } } });
  compat.notify('error', '<img src=x onerror=alert(1)>', '画笺 · 生图失败');
  assert.equal(args[0], '<img src=x onerror=alert(1)>');
  assert.equal(args[2].escapeHtml, true);
  assert.equal(args[2].closeButton, true);
  assert.doesNotThrow(() => createStCompat({}).notify('error', '失败'));
});

test('同时订阅所有存在的消息更新事件', () => {
  const registered = [];
  const handler = () => {};
  const compat = createStCompat({
    getContext: () => ({ chat: [] }),
    eventTypes: {
      MESSAGE_UPDATED: 'message-updated',
      MESSAGE_EDITED: 'message-edited',
    },
    eventSource: {
      on(eventName, callback) {
        registered.push([eventName, callback]);
      },
    },
  });

  const selected = compat.on(['MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MISSING_EVENT'], handler);
  assert.deepEqual(selected, ['message-updated', 'message-edited']);
  assert.deepEqual(registered, [
    ['message-updated', handler],
    ['message-edited', handler],
  ]);
});

test('聊天保存优先交给酒馆的防抖保存', async () => {
  let immediate = 0;
  let debounced = 0;
  const compat = createStCompat({
    saveChatConditional: () => { immediate += 1; },
    saveChatDebounced: () => { debounced += 1; },
  });
  await compat.saveSoon();
  await compat.saveSoon();
  assert.equal(debounced, 2);
  assert.equal(immediate, 0);
  await createStCompat({ saveChatConditional: () => { immediate += 1; } }).saveSoon();
  assert.equal(immediate, 1);
});

test('正文结束时相邻的消息事件只处理同一楼一次', async t => {
  const previousDocument = globalThis.document;
  const previousSetInterval = globalThis.setInterval;
  globalThis.document = { querySelector: () => null };
  globalThis.setInterval = () => 1;
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.setInterval = previousSetInterval;
  });
  const handlers = new Map();
  const message = { is_user: false, mes: '<draw>moonlight</draw>' };
  let mounts = 0;
  let resolutions = 0;
  const events = createMessageEvents({
    compat: {
      on: (names, handler) => names.forEach(name => handlers.set(name, handler)),
      chat: () => [message],
      currentChatId: () => 'chat',
      saveSoon() {},
    },
    api: { resolveTags: async () => { resolutions += 1; return []; } },
    store: { state: { settings: { enabled: false } }, set() {}, setTag() {} },
    renderer: { mount: () => { mounts += 1; }, hasConnected: () => true },
    autoQueue: { enqueue() {} },
  });
  events.bind();
  handlers.get('MESSAGE_RECEIVED')(0);
  handlers.get('CHARACTER_MESSAGE_RENDERED')(0);
  handlers.get('MESSAGE_RENDERED')(0);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(mounts, 1);
  assert.equal(resolutions, 1);
});
