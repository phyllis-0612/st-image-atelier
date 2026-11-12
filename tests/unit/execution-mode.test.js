import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../../src/ui/api/client.js';
import { createMessageEvents } from '../../src/ui/events/message-events.js';
import { createStore } from '../../src/ui/state/store.js';
import { createGenerationRunner } from '../../src/ui/state/generation-runner.js';
import { hasGenerationHistory } from '../../src/ui/state/tag-history.js';

function fixture(t, { serverOnly = false } = {}) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const local = { resultId: 'local-result', tagId: 'tag', storageMode: 'direct',
    localRelativePath: 'user/images/local.png', status: 'available', createdAt: '2026-11-01' };
  const remote = { resultId: 'server-result', tagId: 'tag',
    localRelativePath: '2026/11/server.png', status: 'available', createdAt: '2026-11-02' };
  const tag = { tagId: 'tag', prompt: 'moonlight', ordinal: 0,
    resultIds: serverOnly ? [] : [local.resultId], latestResultId: serverOnly ? null : local.resultId };
  const message = { is_user: false, mes: '<draw>moonlight</draw>',
    extra: { stImageAtelier: { messageUuid: 'message', tags: [tag] } } };
  let serverMissing = false, removed = false, saves = 0;
  const requests = [];
  const ok = data => Response.json({ ok: true, data });
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method });
    if (url.startsWith('/user/files/')) return Response.json({
      results: serverOnly ? {} : { [local.resultId]: local }, attempts: {},
    });
    if (serverMissing) return new Response('', { status: 404 });
    if (url.endsWith('/tags/resolve')) return ok([{
      tagId: 'tag', tag: { tagId: 'tag', prompt: 'moonlight', autoAttempted: true,
        latestResultId: removed ? null : remote.resultId, resultIds: removed ? [] : [remote.resultId] },
      attempts: [], results: removed ? [] : [remote],
    }]);
    if (url.endsWith('/settings')) return ok({});
    if (url.endsWith('/gallery/server-result') && options.method === 'DELETE') {
      removed = true;
      return ok({});
    }
    if (url.includes('/attempts/')) return ok({ attemptId: 'running', status: 'generating' });
    if (url.endsWith('/generate')) return ok({ attemptId: 'running', status: 'generating' });
    throw new Error('Unexpected request: ' + url);
  };
  const compat = { chat: () => [message], currentChatId: () => 'chat', headers: () => ({}),
    saveSoon: async () => { saves++; } };
  const api = createApiClient({ compat, extensionSettings: {}, saveSettingsDebounced() {},
    keyStorage: { getItem() {}, setItem() {} } });
  return { api, compat, tag, message, requests, get saves() { return saves; },
    serverMissing: () => { serverMissing = true; } };
}

test('来回切换模式保留两边旧图、图片地址和聊天引用，读取不产生生图请求', async t => {
  const f = fixture(t);
  for (const executionMode of ['direct', 'server', 'direct']) {
    await f.api.updateSettings({ executionMode });
    const [state] = await f.api.resolveTags(['tag']);
    assert.deepEqual(state.results.map(r => r.resultId), ['local-result', 'server-result']);
    assert.deepEqual(state.tag.resultIds, ['local-result', 'server-result']);
    assert.equal(f.api.fileUrl('local-result'), '/user/images/local.png');
    assert.match(f.api.fileUrl('server-result'), /gallery\/server-result\/file$/);
    assert.equal(hasGenerationHistory(f.tag, state), true);
  }
  assert.equal(f.requests.some(r => r.url.endsWith('/generate')), false);
  assert.equal(f.tag.resultRefs.length, 2);
  const before = f.saves;
  await f.api.resolveTags(['tag']);
  assert.equal(f.saves, before, '重复读取不反复保存聊天');
});

test('增强旧图首次补回聊天引用，服务端暂不可用时不会清空引用或允许自动重画', async t => {
  const f = fixture(t, { serverOnly: true });
  const [state] = await f.api.resolveTags(['tag']);
  assert.equal(state.results.length, 1);
  assert.deepEqual(f.tag.resultIds, ['server-result']);
  f.serverMissing();
  const [missing] = await f.api.resolveTags(['tag']);
  assert.deepEqual(f.tag.resultIds, ['server-result']);
  assert.equal(hasGenerationHistory(f.tag, missing), true);
});

test('切换模式后仍向原服务查询和取消进行中的任务', async t => {
  const f = fixture(t);
  await f.api.updateSettings({ executionMode: 'server' });
  await f.api.generate({ attemptId: 'running' });
  await f.api.updateSettings({ executionMode: 'direct' });
  assert.equal((await f.api.attempt('running')).status, 'generating');
  await f.api.cancel('running');
  assert.ok(f.requests.some(r => r.url.endsWith('/attempts/running/cancel')));
});

test('增强插件暂时不可用仍显示直连旧图，同时阻止自动请求', async t => {
  const f = fixture(t);
  await f.api.updateSettings({ executionMode: 'server' });
  f.serverMissing();
  const [state] = await f.api.resolveTags(['tag']);
  assert.equal(state.results[0].resultId, 'local-result');
  assert.equal(state.historyUnavailable, true);
});

test('在直连模式删除增强图片会找原服务，清除引用并阻止自动补画', async t => {
  const f = fixture(t);
  await f.api.resolveTags(['tag']);
  await f.api.deleteResult('server-result');
  assert.deepEqual(f.tag.resultIds, ['local-result']);
  assert.equal(f.tag.autoSuppressed, true);
  const [state] = await f.api.resolveTags(['tag']);
  assert.deepEqual(state.results.map(r => r.resultId), ['local-result']);
});

for (const kind of ['manual-result', 'saved-reference', 'failed-attempt', 'lookup-failed', 'new']) {
  test('自动生图防重复：' + kind, async () => {
    const tag = { tagId: 'tag', prompt: 'moonlight', ordinal: 0 };
    const state = { tagId: 'tag', tag: { ...tag }, attempts: [], results: [] };
    if (kind === 'manual-result') state.results = [{ resultId: 'old' }];
    if (kind === 'saved-reference') {
      tag.resultIds = ['old'];
      tag.resultRefs = [{ resultId: 'old', localRelativePath: 'user/images/old.png' }];
    }
    if (kind === 'failed-attempt') state.attempts = [{ attemptId: 'old', status: 'failed' }];
    const message = { is_user: false, mes: '<draw>moonlight</draw>',
      extra: { stImageAtelier: { messageUuid: 'message', tags: [tag] } } };
    const store = createStore();
    store.state.settings = { enabled: true, autoGenerate: true };
    const enqueued = [];
    const events = createMessageEvents({
      compat: { chat: () => [message], currentChatId: () => 'chat', saveSoon() {} },
      api: { resolveTags: async () => {
        if (kind === 'lookup-failed') throw new Error('offline');
        return [state];
      } },
      store, renderer: { mount() {}, hasConnected: () => true },
      autoQueue: { enqueue: value => enqueued.push(value) },
    });
    await events.processMessage(0, { live: true });
    assert.equal(enqueued.length, kind === 'new' ? 1 : 0);
  });
}

test('已经排队的旧卡片在执行前仍有最后一道防重复检查', async () => {
  const store = createStore();
  store.setTag('tag', { results: [{ resultId: 'old' }] });
  const runner = createGenerationRunner({ store,
    api: { generate: () => assert.fail('已有旧图不应自动提交新任务') },
    compat: {}, uuid: () => 'new' });
  await runner.generate({ tagId: 'tag', prompt: 'moonlight' }, 'auto');
});
