import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationRunner } from '../../src/ui/state/generation-runner.js';
import { createStore } from '../../src/ui/state/store.js';

function setup(backup = false) {
  const store = createStore();
  const tag = { tagId: 'tag-1', prompt: 'original' };
  const inputs = [];
  const pending = new Map();
  const attempts = new Map();
  let sequence = 0;
  const timers = new Map();
  const notices = [];
  if (backup) store.set({ settings: { ...store.state.settings, enableBackupPreset: true,
    backupPresetId: 'backup', backupWaitSeconds: 47 }, preset: { id: 'default', name: 'main', selectedModel: 'main-model' } });
  const api = {
    mode: () => 'direct',
    attempt: async id => attempts.get(id),
    getPresets: async () => ({ items: [{ id: 'backup', name: 'spare', baseUrl: 'https://backup.example', selectedModel: 'spare-model', hasApiKey: true }] }),
    generate(input) {
      inputs.push(input);
      attempts.set(input.attemptId, { ...input, onProgress: undefined, status: 'generating' });
      return new Promise(resolve => pending.set(input.attemptId, resolve));
    },
    resolveTags: async () => [{ tagId: tag.tagId, tag: {}, attempts: [...attempts.values()].reverse(), results: [] }],
  };
  const runner = createGenerationRunner({ api, store, compat: { currentChatId: () => 'chat', notify: (...args) => notices.push(args) }, setTimer: (fn, ms) => { const id = timers.size + 1; timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id), uuid: () => `attempt-${++sequence}` });
  function finish(id, status = 'succeeded') {
    const value = { ...attempts.get(id), status };
    attempts.set(id, value);
    pending.get(id)(value);
  }
  return { runner, store, tag, inputs, attempts, finish, timers, notices, api };
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

async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test('自定义等待时间只触发一次备用，保留临时提示词且不切换主预设', async () => {
  const f = setup(true);
  const main = f.runner.generate(f.tag, 'manual', { prompt: 'edited prompt' });
  assert.equal([...f.timers.values()][0].ms, 47000);
  assert.equal(f.inputs[0].keepWaitingOnTimeout, true);
  [...f.timers.values()][0].fn();
  await flush();
  assert.equal(f.inputs.length, 2);
  assert.equal(f.inputs[1].presetId, 'backup');
  assert.equal(f.inputs[1].provider, 'openai');
  assert.equal(f.inputs[1].parallel, true);
  assert.equal(f.inputs[1].prompt, 'edited prompt');
  assert.equal(f.inputs[1].backupForAttemptId, f.inputs[0].attemptId);
  assert.equal(f.timers.size, 1, '备用不创建下一轮备用计时');
  assert.equal(f.store.state.preset.id, 'default');
  assert.ok(f.notices.some(item => item[1].includes('47 秒') && item[1].includes('spare')));
  f.finish(f.inputs[1].attemptId);
  await flush();
  assert.equal(f.runner.hasActive(f.tag.tagId), true);
  f.finish(f.inputs[0].attemptId);
  await main;
  assert.equal(f.timers.size, 0);
});

for (const reason of ['disabled', 'finished', 'cancelled', 'downloading', 'missing', 'race', 'server', 'same']) {
  test(`备用不会多发请求：${reason}`, async () => {
    const f = setup(true);
    if (reason === 'server') f.api.mode = () => 'server';
    if (reason === 'same') f.store.set({ settings: { ...f.store.state.settings, backupPresetId: 'default' } });
    const main = f.runner.generate(f.tag, 'manual');
    const timer = [...f.timers.values()][0];
    if (reason === 'disabled') f.store.set({ settings: { ...f.store.state.settings, enableBackupPreset: false } });
    if (reason === 'finished') { f.finish(f.inputs[0].attemptId); await main; }
    if (['cancelled', 'downloading'].includes(reason)) f.attempts.get(f.inputs[0].attemptId).status = reason;
    if (reason === 'missing') f.api.getPresets = async () => ({ items: [] });
    if (reason === 'race') f.api.getPresets = async () => {
      f.attempts.get(f.inputs[0].attemptId).status = 'cancelled';
      return { items: [{ id: 'backup', baseUrl: 'https://backup.example', selectedModel: 'image', hasApiKey: true }] };
    };
    timer?.fn();
    await flush();
    assert.equal(f.inputs.length, 1);
    if (reason !== 'finished') { f.finish(f.inputs[0].attemptId); await main; }
    assert.equal(f.timers.size, 0);
  });
}
