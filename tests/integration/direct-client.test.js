import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDirectApiClient } from '../../src/ui/api/direct-client.js';
import { PNG_BASE64, startMockUpstream } from '../mocks/mock-upstream.js';

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
  });

  const attempt = await client.generate({
    tagId,
    attemptId: crypto.randomUUID(),
    requestMode: 'manual',
    provider: 'novelai',
    artistPresetId: artist.id,
    prompt: '1girl, sunset',
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
  assert.match(novelAiRequest.body.input, /^artist:sample, soft lighting, 1girl, sunset/);
  assert.equal(novelAiRequest.body.parameters.width, 512);
  assert.equal(novelAiRequest.body.parameters.height, 768);

  const [state] = await client.resolveTags([tagId]);
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].provider, 'novelai');
  assert.equal(state.results[0].artistPresetNameSnapshot, '柔光画师串');
  assert.equal(state.results[0].generationSeed, 42);
  assert.doesNotMatch(JSON.stringify(extensionSettings), /nai-secret-token/);
});
