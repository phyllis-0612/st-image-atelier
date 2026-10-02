import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationRunner } from '../../src/ui/state/generation-runner.js';
import { createStore } from '../../src/ui/state/store.js';

function setup() {
  const store = createStore();
  const tag = { tagId: 'tag-1', prompt: 'original' };
  const inputs = [];
  const pending = new Map();
  const attempts = new Map();
  let sequence = 0;
  const api = {
    generate(input) {
      inputs.push(input);
      attempts.set(input.attemptId, { ...input, onProgress: undefined, status: 'generating' });
      return new Promise(resolve => pending.set(input.attemptId, resolve));
    },
    resolveTags: async () => [{ tagId: tag.tagId, tag: {}, attempts: [...attempts.values()].reverse(), results: [] }],
  };
  const runner = createGenerationRunner({ api, store, compat: { currentChatId: () => 'chat', notify() {} }, uuid: () => `attempt-${++sequence}` });
  function finish(id, status = 'succeeded') {
    const value = { ...attempts.get(id), status };
    attempts.set(id, value);
    pending.get(id)(value);
  }
  return { runner, store, tag, inputs, attempts, finish };
}

test('同标签可并行手动重 roll，旧任务进度不覆盖新任务，自动排队不重复发送', async () => {
  const f = setup();
  const old = f.runner.generate(f.tag, 'auto');
  const newer = f.runner.generate(f.tag, 'manual');
  assert.equal(f.inputs.length, 2);
  assert.equal(f.inputs[1].parallel, true);
  await f.runner.generate(f.tag, 'auto');
  assert.equal(f.inputs.length, 2);
  f.inputs[0].onProgress({ attemptId: f.inputs[0].attemptId, status: 'generating', statusMessage: 'still waiting' });
  assert.equal(f.store.state.tagStates.get(f.tag.tagId).attempts[0].attemptId, f.inputs[1].attemptId);
  f.finish(f.inputs[1].attemptId);
  await newer;
  assert.equal(f.runner.hasActive(f.tag.tagId), true, '第二次先结束不能释放第一次的运行记录');
  f.finish(f.inputs[0].attemptId);
  await old;
  assert.equal(f.runner.hasActive(f.tag.tagId), false);
});

test('新请求还没落盘时，旧请求的状态刷新不能清掉它的乐观记录', async () => {
  const f = setup();
  const old = f.runner.generate(f.tag, 'manual');
  const newer = f.runner.generate(f.tag, 'manual');
  const newerRecord = f.attempts.get(f.inputs[1].attemptId);
  f.attempts.delete(f.inputs[1].attemptId);
  await f.runner.refreshTag(f.tag.tagId);
  assert.ok(f.store.state.tagStates.get(f.tag.tagId).attempts.some(item => item.attemptId === f.inputs[1].attemptId));
  f.attempts.set(f.inputs[1].attemptId, newerRecord);
  f.finish(f.inputs[1].attemptId, 'cancelled');
  await newer;
  assert.equal(f.runner.hasActive(f.tag.tagId), true);
  f.finish(f.inputs[0].attemptId);
  await old;
});
