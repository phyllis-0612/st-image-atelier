import test from 'node:test';
import assert from 'node:assert/strict';
import { createStCompat } from '../../src/ui/compat/st-api.js';

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
