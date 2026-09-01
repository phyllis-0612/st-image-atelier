import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoQueue } from '../../src/ui/state/auto-queue.js';

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

test('同一标签在排队或生成期间只会进入自动队列一次', async () => {
  const releases = [];
  let calls = 0;
  const queue = createAutoQueue(async () => {
    calls += 1;
    await new Promise(resolve => releases.push(resolve));
  });
  const tag = { tagId: 'tag-a' };

  assert.equal(queue.enqueue(tag), true);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(queue.enqueue(tag), false);

  releases.shift()();
  await nextTurn();
  assert.equal(queue.enqueue(tag), true);
  await Promise.resolve();
  assert.equal(calls, 2);
  releases.shift()();
  await nextTurn();
});
