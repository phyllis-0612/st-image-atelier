import test from 'node:test';
import assert from 'node:assert/strict';
import { createStCompat } from '../../src/ui/compat/st-api.js';

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
