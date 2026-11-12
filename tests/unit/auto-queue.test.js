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

test('等待的自动任务立即报告排队，并能在不提交请求的情况下取消', async () => {
  let release;
  const calls = [], changes = [];
  const queue = createAutoQueue(async tag => {
    calls.push(tag.tagId);
    await new Promise(resolve => { release = resolve; });
  }, {
    onQueued: tag => changes.push('queued:' + tag.tagId),
    onDequeued: tag => changes.push('dequeued:' + tag.tagId),
  });
  queue.enqueue({ tagId: 'a' });
  queue.enqueue({ tagId: 'b' });
  assert.deepEqual(changes, ['queued:a', 'dequeued:a', 'queued:b']);
  assert.deepEqual(calls, ['a']);
  assert.equal(queue.cancel('b'), true);
  assert.equal(queue.cancel('a'), false, '运行中的任务仍走原 API 取消');
  release();
  await nextTurn();
  assert.deepEqual(calls, ['a']);
});
