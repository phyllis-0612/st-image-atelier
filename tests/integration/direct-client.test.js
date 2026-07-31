import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDirectApiClient } from '../../src/ui/api/direct-client.js';
import { startMockUpstream } from '../mocks/mock-upstream.js';

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
