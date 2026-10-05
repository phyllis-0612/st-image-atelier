import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDirectApiClient } from '../../src/ui/api/direct-client.js';
import { createMemoryGalleryMetadataStore } from '../../src/ui/api/gallery-metadata-store.js';
import { PNG_BASE64, startMockUpstream } from '../mocks/mock-upstream.js';
import { createGenerationNotifications } from '../../src/ui/state/generation-notifications.js';
import { createGenerationRunner } from '../../src/ui/state/generation-runner.js';
import { createStore } from '../../src/ui/state/store.js';

async function waitUntil(predicate) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('等待测试请求超时');
}

async function concurrentFixture(t, clock = {}) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  const uploads = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/api/images/upload') {
      const input = JSON.parse(options.body);
      uploads.push(input.filename);
      return response(200, { path: `user/images/${input.filename}.${input.format}` });
    }
    if (url === '/api/images/delete') return response(200, {});
    return new Promise((resolve, reject) => {
      requests.push({ url, body: JSON.parse(options.body), key: options.headers.Authorization, signal: options.signal,
        finish: () => resolve(response(200, { data: [{ b64_json: PNG_BASE64 }] })) });
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  const tag = { tagId: crypto.randomUUID(), prompt: 'original', ordinal: 0, attempts: [], resultIds: [] };
  const message = { mes: '<draw>original</draw>', extra: { stImageAtelier: { tags: [tag] } } };
  const keys = new Map();
  const compat = { chat: () => [message], save: async () => {}, headers: () => ({}), currentChatId: () => 'chat', notify() {} };
  const client = createDirectApiClient({ compat, extensionSettings: {}, saveSettingsDebounced() {},
    galleryStore: createMemoryGalleryMetadataStore(),
    keyStorage: { getItem: key => keys.get(key), setItem: (key, value) => keys.set(key, value) } });
  await client.updatePreset({ baseUrl: 'https://example.com', apiKey: 'key-old', selectedModel: 'image', timeoutMs: 5 });
  const store = createStore();
  const runner = createGenerationRunner({ api: client, compat, store, ...clock, uuid: () => crypto.randomUUID() });
  return { client, runner, store, tag, requests, uploads };
}

for (const first of [0, 1]) {
  test(`直连换 Key 并行生成，第 ${first + 1} 个请求先回图，两次结果和历史都保留`, async t => {
    const f = await concurrentFixture(t);
    const old = f.runner.generate(f.tag, 'manual');
    // Change credentials before the first async initialization completes.
    await f.client.updatePreset({ apiKey: 'key-new' });
    await waitUntil(() => f.requests.length === 1);
    const newer = f.runner.generate(f.tag, 'manual');
    await waitUntil(() => f.requests.length === 2);
    assert.deepEqual(f.requests.map(item => item.key), ['Bearer key-old', 'Bearer key-new']);
    await waitUntil(() => f.tag.attempts.every(item => item.statusMessage?.includes('仍在等待')));
    assert.equal(f.requests.every(item => !item.signal.aborted), true);
    assert.equal(f.requests.length, 2, '等待提醒不额外扣费重发');
    const works = [old, newer];
    f.requests[first].finish();
    const initial = await works[first];
    assert.equal(initial.status, 'succeeded');
    assert.equal(f.runner.hasActive(f.tag.tagId), true);
    let [state] = await f.client.resolveTags([f.tag.tagId]);
    assert.equal(state.results.length, 1);
    assert.equal(state.attempts.filter(item => item.status === 'generating').length, 1);
    const second = 1 - first;
    f.requests[second].finish();
    const later = await works[second];
    [state] = await f.client.resolveTags([f.tag.tagId]);
    assert.equal(state.results.length, 2);
    assert.equal(state.tag.resultIds.length, 2);
    assert.equal(state.tag.latestResultId, later.resultIds[0]);
    assert.equal(f.uploads.length, 2);
    assert.equal(f.runner.hasActive(f.tag.tagId), false);
    assert.ok(state.attempts.every(item => !JSON.stringify(item).includes('key-old') && !JSON.stringify(item).includes('key-new')));
  });
}

test('取消一条并行请求不影响另一条请求回图', async t => {
  const f = await concurrentFixture(t);
  const old = f.runner.generate(f.tag, 'manual');
  const newer = f.runner.generate(f.tag, 'manual');
  await waitUntil(() => f.requests.length === 2);
  const newestId = f.tag.attempts[0].attemptId;
  await f.client.cancel(newestId);
  assert.equal((await newer).status, 'cancelled');
  assert.equal(f.requests[0].signal.aborted, false);
  f.requests[0].finish();
  assert.equal((await old).status, 'succeeded');
  const [state] = await f.client.resolveTags([f.tag.tagId]);
  assert.equal(state.results.length, 1);
  assert.equal(state.attempts.find(item => item.attemptId === newestId).status, 'cancelled');
});

for (const first of [0, 1]) {
  test(`自动备用使用独立 Key，${first === 0 ? '主' : '备用'}请求先回图仍保留两图`, async t => {
    let fire;
    const f = await concurrentFixture(t, { setTimer: (fn, ms) => { fire = fn; assert.equal(ms, 61000); return 1; }, clearTimer() {} });
    const backup = await f.client.createPreset({ name: 'backup' });
    await f.client.updatePreset(backup.id, { baseUrl: 'https://backup.example.com', apiKey: 'key-backup', selectedModel: 'backup-image', timeoutMs: 5 });
    await f.client.selectPreset('default');
    const settings = await f.client.updateSettings({ enableBackupPreset: true, backupPresetId: backup.id, backupWaitSeconds: 61, keepWaitingOnTimeout: false });
    const { items } = await f.client.getPresets();
    f.store.set({ settings, preset: items.find(item => item.id === 'default') });
    const main = f.runner.generate(f.tag, 'manual', { prompt: 'edited' });
    await waitUntil(() => f.requests.length === 1);
    fire();
    await waitUntil(() => f.requests.length === 2);
    assert.deepEqual(f.requests.map(item => item.key), ['Bearer key-old', 'Bearer key-backup']);
    assert.match(f.requests[1].url, /^https:\/\/backup\.example\.com/);
    assert.equal(f.requests[1].body.model, 'backup-image');
    assert.equal(f.requests[1].body.prompt, 'edited');
    await waitUntil(() => f.tag.attempts.every(item => item.statusMessage?.includes('仍在等待')));
    assert.ok(f.requests.every(item => !item.signal.aborted), '主请求与备用都越过硬超时继续接图');
    assert.equal((await f.client.getPresets()).activePresetId, 'default');
    f.requests[first].finish();
    await waitUntil(() => f.uploads.length === 1);
    assert.equal(f.runner.hasActive(f.tag.tagId), true);
    f.requests[1 - first].finish();
    await main;
    await waitUntil(() => !f.runner.hasActive(f.tag.tagId));
    const [state] = await f.client.resolveTags([f.tag.tagId]);
    assert.equal(state.results.length, 2);
    assert.ok(state.attempts.every(item => item.promptSnapshot === 'edited'));
    assert.equal(state.attempts.filter(item => item.backupForAttemptId).length, 1);
  });
}


function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('直连完整任务失败时及时通知三轮重试，保存失败状态且幂等重入不重新生成', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response(502, { error: { message: 'Upstream service temporarily unavailable' } });
  };
  const tagId = crypto.randomUUID();
  const tag = { tagId, prompt: 'original', ordinal: 0, attempts: [], resultIds: [] };
  const message = { mes: '<draw>original</draw>', extra: { stImageAtelier: { tags: [tag] } } };
  const keys = new Map();
  const client = createDirectApiClient({
    compat: { chat: () => [message], save: async () => {}, headers: () => ({}) },
    extensionSettings: {}, saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(), retryDelays: [0, 0, 0],
    keyStorage: { getItem: key => keys.get(key), setItem: (key, value) => keys.set(key, value) },
  });
  await client.updateSettings({ enableSmartRetry: true });
  await client.updatePreset({ baseUrl: 'https://example.com', apiKey: 'test', selectedModel: 'image' });
  const banners = [];
  const notifications = createGenerationNotifications((...args) => banners.push(args));
  const input = { tagId, attemptId: `auto:${tagId}`, requestMode: 'auto', prompt: 'original', parameters: {},
    onProgress: attempt => {
      assert.equal(attempt.status, 'generating');
      assert.ok(calls < 4, '错误横幅在任务结束前就能显示');
      notifications.progress(attempt);
    },
  };
  await assert.rejects(client.generate(input), error => error.autoRetryCount === 3);
  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].status, 'failed');
  assert.equal(state.attempts[0].retryCount, 3);
  assert.equal(calls, 4);
  notifications.failed(state.attempts[0], state.attempts[0].retryCount);
  assert.deepEqual(banners.map(value => value[0]), ['warning', 'warning', 'warning', 'error']);
  const duplicate = await client.generate(input);
  assert.equal(duplicate.status, 'failed');
  assert.equal(calls, 4);
});

function storedZip(name, data) {
  const nameBytes = Buffer.from(name);
  const body = Buffer.from(data);
  const local = Buffer.alloc(30 + nameBytes.length + body.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  body.copy(local, 30 + nameBytes.length);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

test('仓库链接直装模式完成生成、幂等、画廊与删除', async t => {
  const upstream = await startMockUpstream();
  const originalFetch = globalThis.fetch;
  const uploads = new Map();
  let deleteCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      const path = `user/images/st-image-atelier/${body.filename}.${body.format}`;
      uploads.set(path, body.image);
      return response(200, { path });
    }
    if (url === '/api/images/delete') {
      const body = JSON.parse(options.body);
      deleteCalls += 1;
      uploads.delete(body.path);
      return response(200, {});
    }
    return originalFetch(url, options);
  };

  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = {
    is_user: false,
    mes: '<draw>base64</draw>',
    extra: {
      stImageAtelier: {
        messageUuid,
        schemaVersion: 2,
        tags: [{
          tagId,
          prompt: 'base64',
          ordinal: 0,
          count: 1,
          attempts: [],
          results: [],
          resultIds: [],
          latestResultId: null,
          autoAttempted: false,
          autoSuppressed: false,
        }],
      },
    },
  };
  let chatSaves = 0;
  let settingsSaves = 0;
  const storage = new Map();
  const extensionSettings = {};
  const client = createDirectApiClient({
    compat: {
      chat: () => [message],
      save: async () => { chatSaves += 1; },
      headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
    },
    extensionSettings,
    saveSettingsDebounced: () => { settingsSaves += 1; },
    galleryStore: createMemoryGalleryMetadataStore(),
    keyStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });

  await client.updateSettings({ allowHttp: true });
  await client.updatePreset({
    baseUrl: upstream.baseUrl,
    apiKey: 'sk-test',
    selectedModel: 'gpt-image-1',
  });
  const models = await client.listModels();
  assert.deepEqual(models.models, [{ id: 'gpt-image-1', ownedBy: 'mock' }]);

  const attemptId = crypto.randomUUID();
  const input = {
    tagId,
    attemptId,
    requestMode: 'manual',
    prompt: 'base64',
    chatId: 'chat-1',
    messageUuid,
    tagOrdinal: 0,
    parameters: { count: 1, ratio: 'square' },
  };
  const attempt = await client.generate(input);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attempt.resultIds.length, 1);
  assert.equal(uploads.size, 1);
  assert.ok(chatSaves >= 4);
  assert.ok(settingsSaves >= 3);

  const duplicate = await client.generate(input);
  assert.equal(duplicate.attemptId, attemptId);
  assert.equal(upstream.state.generationCalls, 1);

  const cancelId = crypto.randomUUID();
  const pending = client.generate({
    ...input,
    attemptId: cancelId,
    prompt: 'timeout',
  });
  while (upstream.state.generationCalls < 2) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const activeState = (await client.resolveTags([tagId]))[0];
  assert.notEqual(
    activeState.attempts.find(item => item.attemptId === cancelId)?.status,
    'interrupted',
  );
  await client.cancel(cancelId);
  assert.equal((await pending).status, 'cancelled');

  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.results[0].status, 'available');
  assert.match(client.fileUrl(state.results[0].resultId), /^\/user\/images\//);
  const page = await client.gallery();
  assert.equal(page.items.length, 1);

  await client.deleteResult(state.results[0].resultId);
  assert.equal(deleteCalls, 1);
  assert.equal((await client.gallery()).items.length, 0);
  assert.equal((await client.resolveTags([tagId]))[0].tag.autoSuppressed, true);

  const serializedSettings = JSON.stringify(extensionSettings);
  assert.doesNotMatch(serializedSettings, /sk-test/);

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await upstream.close();
  });
});

test('保存触发消息重绘时不会把当前自动任务误判为 interrupted', async t => {
  const upstream = await startMockUpstream();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      return response(200, { path: `user/images/st-image-atelier/${body.filename}.${body.format}` });
    }
    return originalFetch(url, options);
  };

  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = {
    is_user: false,
    mes: '<draw>base64</draw>',
    extra: {
      stImageAtelier: {
        messageUuid,
        schemaVersion: 2,
        tags: [{
          tagId,
          prompt: 'base64',
          ordinal: 0,
          count: 1,
          attempts: [],
          results: [],
          resultIds: [],
          latestResultId: null,
          autoAttempted: false,
          autoSuppressed: false,
        }],
      },
    },
  };
  const storage = new Map();
  const observedStatuses = [];
  let client;
  let resolving = false;
  const compat = {
    chat: () => [message],
    save: async () => {
      message.extra.stImageAtelier = structuredClone(message.extra.stImageAtelier);
      if (!client || resolving) return;
      resolving = true;
      try {
        const [state] = await client.resolveTags([tagId]);
        observedStatuses.push(state.attempts[0]?.status || 'none');
      } finally {
        resolving = false;
      }
    },
    headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
  };
  client = createDirectApiClient({
    compat,
    extensionSettings: {},
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    keyStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });
  await client.updateSettings({ allowHttp: true });
  await client.updatePreset({
    baseUrl: upstream.baseUrl,
    apiKey: 'sk-test',
    selectedModel: 'gpt-image-1',
  });

  const attempt = await client.generate({
    tagId,
    attemptId: `auto:${tagId}`,
    requestMode: 'auto',
    prompt: 'base64',
    chatId: 'chat-1',
    messageUuid,
    tagOrdinal: 0,
    parameters: { count: 1, ratio: 'square' },
  });
  const [state] = await client.resolveTags([tagId]);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(state.attempts[0].status, 'succeeded');
  assert.equal(state.results.length, 1);
  assert.equal(observedStatuses.includes('interrupted'), false);
  assert.equal(observedStatuses.includes('queued'), false);
  assert.equal(observedStatuses.includes('generating'), true);
  assert.equal(upstream.state.generationCalls, 1);

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await upstream.close();
  });
});

test('GPT 临时提示词覆盖只用于本次请求，保存快照且不改原标签，并可持久收藏', async t => {
  const originalFetch = globalThis.fetch;
  const requestBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'https://api.example.com/v1/images/generations') {
      requestBodies.push(JSON.parse(options.body));
      if (requestBodies.length === 1) {
        return response(400, { error: { message: "Unknown parameter: 'response_format'." } });
      }
      return response(200, { data: [{ b64_json: PNG_BASE64 }] });
    }
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      return response(200, { path: `user/images/st-image-atelier/${body.filename}.${body.format}` });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const originalMes = '<draw>original prompt</draw>';
  const tag = {
    tagId,
    prompt: 'original prompt',
    ordinal: 0,
    attempts: [],
    results: [],
    resultIds: [],
    latestResultId: null,
  };
  const message = {
    mes: originalMes,
    extra: { stImageAtelier: { messageUuid, tags: [tag] } },
  };
  const storage = new Map();
  const extensionSettings = {};
  const options = {
    compat: {
      chat: () => [message],
      save: async () => {},
      headers: () => ({ 'Content-Type': 'application/json' }),
    },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    keyStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  };
  const client = createDirectApiClient(options);
  await client.updateSettings({ enableSmartRetry: true });
  await client.updatePreset({
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test',
    selectedModel: 'gpt-image-1',
  });
  const attempt = await client.generate({
    tagId,
    attemptId: crypto.randomUUID(),
    requestMode: 'manual',
    prompt: 'temporary changed prompt',
    chatId: 'chat-1',
    messageUuid,
    tagOrdinal: 0,
    parameters: { count: 1 },
  });
  assert.equal(requestBodies[0].prompt, 'temporary changed prompt');
  assert.equal(requestBodies.length, 2);
  assert.equal('response_format' in requestBodies[1], false);
  assert.equal(tag.prompt, 'original prompt');
  assert.equal(message.mes, originalMes);
  const [state] = await client.resolveTags([tagId]);
  const result = state.results.find(value => value.resultId === attempt.resultIds[0]);
  assert.equal(result.prompt, 'temporary changed prompt');
  assert.equal('promptSnapshot' in result, false);
  assert.equal('resolvedPrompt' in result, false);
  assert.deepEqual(result.compatibilityRetry.adjustedParameters, ['response_format']);
  assert.equal(Number.isFinite(result.generationDurationMs), true);
  assert.ok(result.generationDurationMs >= 0);
  assert.ok(result.generationDurationMs <= Date.parse(attempt.completedAt) - Date.parse(attempt.createdAt));

  await client.setFavorite(result.resultId, true);
  assert.equal((await client.galleryMetadata()).items[0].favorite, true);
  assert.equal('gallery' in extensionSettings.stImageAtelier, false);
  const reloaded = createDirectApiClient(options);
  assert.equal((await reloaded.galleryMetadata()).items[0].favorite, true);
  assert.equal((await reloaded.galleryMetadata()).items[0].generationDurationMs, result.generationDurationMs);
});

test('旧版单预设迁移为多预设，且每个预设独立保存密钥', async () => {
  const storage = new Map([['stImageAtelier.directApiKey.v1', 'sk-legacy']]);
  const extensionSettings = {
    stImageAtelier: {
      preset: {
        id: 'default',
        name: '旧版主站',
        baseUrl: 'https://api.example.com',
        selectedModel: 'model-old',
      },
    },
  };
  const client = createDirectApiClient({
    compat: {
      chat: () => [],
      save: async () => {},
      headers: () => ({ 'Content-Type': 'application/json' }),
    },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    keyStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });

  let data = await client.getPresets();
  assert.equal(data.activePresetId, 'default');
  assert.equal(data.items[0].name, '旧版主站');
  assert.equal(data.items[0].hasApiKey, true);
  assert.equal(extensionSettings.stImageAtelier.preset, undefined);
  assert.equal(extensionSettings.stImageAtelier.presets.length, 1);

  const backup = await client.createPreset({ name: '备用 API' });
  await client.updatePreset(backup.id, {
    baseUrl: 'https://backup.example.com',
    apiKey: 'sk-backup',
    selectedModel: 'model-new',
  });
  data = await client.getPresets();
  assert.equal(data.items.length, 2);
  assert.equal(data.activePresetId, backup.id);
  assert.equal(data.items.find(item => item.id === backup.id).hasApiKey, true);

  await client.clearSecret(backup.id);
  data = await client.getPresets();
  assert.equal(data.items.find(item => item.id === backup.id).hasApiKey, false);
  assert.equal(data.items.find(item => item.id === 'default').hasApiKey, true);

  const selected = await client.selectPreset('default');
  assert.equal(selected.name, '旧版主站');
  const removed = await client.deletePreset(backup.id);
  assert.equal(removed.activePreset.id, 'default');
  assert.equal((await client.getPresets()).items.length, 1);
  assert.doesNotMatch(JSON.stringify(extensionSettings), /sk-(?:legacy|backup)/);
});

test('NovelAI 引擎使用独立 Token、画师串预设并保存生成结果', async t => {
  const originalFetch = globalThis.fetch;
  const png = Buffer.from(PNG_BASE64, 'base64');
  const zip = storedZip('image_0.png', png);
  let novelAiRequest;
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'https://nai.example/ai/generate-image') {
      novelAiRequest = { options, body: JSON.parse(options.body) };
      return new Response(zip, {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      });
    }
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      return response(200, { path: `user/images/st-image-atelier/${body.filename}.${body.format}` });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const tagId = crypto.randomUUID();
  const messageUuid = crypto.randomUUID();
  const message = {
    is_user: false,
    mes: '<draw>1girl, sunset</draw>',
    extra: {
      stImageAtelier: {
        messageUuid,
        schemaVersion: 4,
        tags: [{
          tagId,
          prompt: '1girl, sunset',
          ordinal: 0,
          count: 1,
          attempts: [],
          results: [],
          resultIds: [],
          latestResultId: null,
          autoAttempted: false,
          autoSuppressed: false,
        }],
      },
    },
  };
  const storage = new Map();
  const extensionSettings = {};
  const client = createDirectApiClient({
    compat: {
      chat: () => [message],
      save: async () => {},
      headers: () => ({ 'Content-Type': 'application/json' }),
    },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    keyStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });
  await client.updateSettings({ generationProvider: 'novelai' });
  await client.updateNovelAi({
    baseUrl: 'https://nai.example',
    apiKey: 'nai-secret-token',
    model: 'nai-diffusion-4-5-full',
    defaultSize: '512x768',
    seed: 42,
  });
  const novelAiData = await client.getNovelAi();
  const artist = await client.updateArtistPreset(novelAiData.activeArtistPresetId, {
    name: '柔光画师串',
    prompt: 'artist:sample, soft lighting',
    negativePrompt: 'artist negative anatomy',
  });

  const attempt = await client.generate({
    tagId,
    attemptId: crypto.randomUUID(),
    requestMode: 'manual',
    provider: 'novelai',
    artistPresetId: artist.id,
    prompt: '1girl, moonlight',
    negativePromptOverride: 'bad hands, lowres',
    chatId: 'chat-nai',
    messageUuid,
    tagOrdinal: 0,
    parameters: { count: 1 },
  });
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attempt.provider, 'novelai');
  assert.equal(attempt.artistPresetNameSnapshot, '柔光画师串');
  assert.equal(attempt.generationSeed, 42);
  assert.equal(novelAiRequest.options.headers.Authorization, 'Bearer nai-secret-token');
  assert.match(novelAiRequest.body.input, /^artist:sample, soft lighting, 1girl, moonlight/);
  assert.match(
    novelAiRequest.body.parameters.negative_prompt,
    /^artist negative anatomy, bad hands, lowres/,
  );
  assert.equal(novelAiRequest.body.parameters.width, 512);
  assert.equal(novelAiRequest.body.parameters.height, 768);

  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].provider, 'novelai');
  assert.equal(state.results[0].prompt, '1girl, moonlight');
  assert.equal(state.results[0].negativePrompt, 'bad hands, lowres');
  assert.equal(message.extra.stImageAtelier.tags[0].prompt, '1girl, sunset');
  assert.equal(message.mes, '<draw>1girl, sunset</draw>');
  assert.equal(state.results[0].artistPresetNameSnapshot, '柔光画师串');
  assert.equal(state.results[0].generationSeed, 42);
  assert.doesNotMatch(JSON.stringify(extensionSettings), /nai-secret-token/);
});

test('直连画廊按时间或数量自动清理，合并并发检查且真删元数据', async t => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const tagId = crypto.randomUUID();
  const values = [
    { age: 10, name: 'expired' },
    { age: 5, name: 'overflow' },
    { age: 2, name: 'middle' },
    { age: 1, name: 'newest' },
  ].map(({ age, name }) => ({
    resultId: crypto.randomUUID(),
    tagId,
    prompt: name,
    apiModel: 'test-model',
    localRelativePath: `user/images/st-image-atelier/${name}.png`,
    status: 'available',
    createdAt: new Date(now - age * 24 * 60 * 60 * 1000).toISOString(),
    deletedAt: null,
  }));
  const deletedPaths = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(url, '/api/images/delete');
    deletedPaths.push(JSON.parse(options.body).path);
    return response(200, {});
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const tag = {
    tagId,
    results: structuredClone(values),
    resultIds: values.map(item => item.resultId),
    latestResultId: values.at(-1).resultId,
    attempts: [],
    autoSuppressed: false,
  };
  const message = { extra: { stImageAtelier: { tags: [tag] } } };
  let chatSaves = 0;
  let settingsSaves = 0;
  const extensionSettings = {
    stImageAtelier: {
      settings: {
        galleryCleanupByAge: true,
        galleryMaxAgeDays: 7,
        galleryCleanupByCount: true,
        galleryMaxCount: 2,
      },
      gallery: structuredClone(values),
    },
  };
  const client = createDirectApiClient({
    compat: {
      chat: () => [message],
      save: async () => { chatSaves += 1; },
      headers: () => ({ 'Content-Type': 'application/json' }),
    },
    extensionSettings,
    saveSettingsDebounced: () => { settingsSaves += 1; },
    galleryStore: createMemoryGalleryMetadataStore(),
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });

  const [first, second] = await Promise.all([client.cleanupGallery(), client.cleanupGallery()]);
  assert.deepEqual(first, second);
  assert.equal(first.deletedCount, 2);
  assert.equal(first.keptCount, 2);
  assert.equal(first.byAgeCount, 1);
  assert.equal(first.byCountCount, 2);
  assert.deepEqual(deletedPaths, values.slice(0, 2).map(item => item.localRelativePath));
  assert.equal(chatSaves, 1);
  assert.equal(settingsSaves, 1);
  assert.equal(tag.autoSuppressed, true);
  assert.deepEqual(tag.resultIds, values.slice(2).map(item => item.resultId));
  assert.equal(tag.latestResultId, values.at(-1).resultId);
  assert.deepEqual((await client.gallery()).items.map(item => item.resultId), [
    values[3].resultId,
    values[2].resultId,
  ]);
  assert.equal((await client.resolveTags([tagId]))[0].results.length, 2);
  assert.equal('results' in tag, false);
  assert.equal('gallery' in extensionSettings.stImageAtelier, false);
  assert.equal('deletedResultIds' in extensionSettings.stImageAtelier, false);
});

test('画廊元数据迁移后新增记录不改写 extension_settings', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'https://api.example.com/v1/images/generations') {
      return response(200, { data: [{ b64_json: PNG_BASE64 }] });
    }
    if (url === '/api/images/upload') {
      const body = JSON.parse(options.body);
      return response(200, { path: `user/images/st-image-atelier/${body.filename}.${body.format}` });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const longPrompt = 'artist style, detailed lighting, '.repeat(150);
  const gallery = Array.from({ length: 50 }, (_, index) => ({
    resultId: crypto.randomUUID(),
    tagId: crypto.randomUUID(),
    prompt: longPrompt,
    promptSnapshot: longPrompt,
    resolvedPrompt: longPrompt,
    localRelativePath: `user/images/st-image-atelier/legacy-${index}.png`,
    mimeType: 'image/png',
    status: 'available',
    createdAt: new Date(Date.parse('2026-09-01T00:00:00.000Z') + index * 1000).toISOString(),
  }));
  const tagId = crypto.randomUUID();
  const message = {
    mes: '<draw>new prompt</draw>',
    extra: {
      stImageAtelier: {
        tags: [{
          tagId,
          prompt: 'new prompt',
          attempts: [],
          resultIds: [],
          latestResultId: null,
        }],
      },
    },
  };
  const extensionSettings = {
    stImageAtelier: {
      settings: { enabled: true },
      presets: [{
        id: 'default',
        name: '主站',
        baseUrl: 'https://api.example.com',
        selectedModel: 'gpt-image-1',
      }],
      artistPresets: [{ id: 'default', name: '默认画师串', prompt: '', negativePrompt: '' }],
      novelAi: {},
      activePresetId: 'default',
      activeArtistPresetId: 'default',
      gallery,
      deletedResultIds: [],
      schemaVersion: 6,
    },
  };
  const galleryStore = createMemoryGalleryMetadataStore();
  const client = createDirectApiClient({
    compat: {
      chat: () => [message],
      save: async () => {},
      headers: () => ({ 'Content-Type': 'application/json' }),
    },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore,
    keyStorage: {
      getItem: key => key === 'stImageAtelier.directApiKey.v2:default' ? 'sk-test' : null,
      setItem() {},
      removeItem() {},
    },
  });

  await client.getSettings();
  assert.deepEqual(Object.keys(extensionSettings.stImageAtelier).sort(), [
    'activeArtistPresetId',
    'activePresetId',
    'artistPresets',
    'novelAi',
    'presets',
    'schemaVersion',
    'settings',
  ]);
  assert.equal(extensionSettings.stImageAtelier.schemaVersion, 8);
  const migrated = Object.values(galleryStore.document.results);
  assert.equal(migrated.length, 50);
  assert.equal(migrated[0].prompt, longPrompt);
  assert.equal('promptSnapshot' in migrated[0], false);
  assert.equal('resolvedPrompt' in migrated[0], false);

  const settingsBefore = JSON.stringify(extensionSettings);
  await client.generate({
    tagId,
    attemptId: crypto.randomUUID(),
    requestMode: 'manual',
    prompt: 'new prompt',
    chatId: 'chat-1',
    messageUuid: crypto.randomUUID(),
    tagOrdinal: 0,
    parameters: { count: 1 },
  });
  const settingsAfter = JSON.stringify(extensionSettings);
  assert.equal(settingsAfter, settingsBefore);
  assert.equal(Object.keys(galleryStore.document.results).length, 51);
});

test('独立画廊文件写入失败时保留旧 settings 数据以便重试', async () => {
  const legacy = {
    resultId: crypto.randomUUID(),
    prompt: 'must survive',
    status: 'available',
  };
  const extensionSettings = {
    stImageAtelier: { gallery: [legacy], schemaVersion: 6 },
  };
  const client = createDirectApiClient({
    compat: { chat: () => [], save: async () => {}, headers: () => ({}) },
    extensionSettings,
    saveSettingsDebounced: () => {},
    galleryStore: {
      initialize: async () => { throw new Error('disk full'); },
    },
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  await assert.rejects(client.getSettings(), /disk full/);
  assert.deepEqual(extensionSettings.stImageAtelier.gallery, [legacy]);
  assert.equal(extensionSettings.stImageAtelier.schemaVersion, 6);
});

test('已迁移版本不会从旧聊天副本复活已删除的画廊记录', async () => {
  const resultId = crypto.randomUUID();
  const tagId = crypto.randomUUID();
  const tag = {
    tagId,
    attempts: [],
    resultIds: [resultId],
    latestResultId: resultId,
    results: [{ resultId, tagId, prompt: 'stale', status: 'available' }],
  };
  const client = createDirectApiClient({
    compat: {
      chat: () => [{ extra: { stImageAtelier: { tags: [tag] } } }],
      save: async () => {},
      headers: () => ({}),
    },
    extensionSettings: { stImageAtelier: { schemaVersion: 8 } },
    saveSettingsDebounced: () => {},
    galleryStore: createMemoryGalleryMetadataStore(),
    keyStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.results.length, 0);
  assert.equal('results' in tag, false);
  assert.deepEqual(tag.resultIds, []);
  assert.equal((await client.galleryMetadata()).total, 0);
});

for (const [name, patch, parameters, expected] of [
  ['default', { defaultQuality: 'xhigh' }, {}, 'xhigh'],
  ['tag override', { defaultQuality: 'high' }, { quality: 'max' }, 'max'],
  ['omitted', { defaultQuality: 'high', sendQuality: false }, { quality: 'max' }, null],
  ['extra body', { defaultQuality: 'high', extraBody: { quality: 'hd' } }, {}, 'hd'],
]) {
  test(`新图片保存实际画质快照：${name}`, async t => {
    const f = await concurrentFixture(t);
    await f.client.updatePreset(patch);
    f.tag.quality = parameters.quality;
    const work = f.runner.generate(f.tag, 'manual');
    await waitUntil(() => f.requests.length === 1);
    assert.equal(f.requests[0].body.quality ?? null, expected);
    f.requests[0].finish();
    const attempt = await work;
    const [state] = await f.client.resolveTags([f.tag.tagId]);
    assert.equal(attempt.parameters.quality, expected);
    assert.equal(state.results[0].parameters.quality, expected);
    const gallery = await f.client.galleryMetadata();
    assert.equal(gallery.items[0].parameters.quality, expected);
    await f.client.updatePreset({ defaultQuality: 'low' });
    assert.equal((await f.client.galleryMetadata()).items[0].parameters.quality, expected);
  });
}
