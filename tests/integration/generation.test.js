import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { startMockUpstream } from '../mocks/mock-upstream.js';

const require = createRequire(import.meta.url);
const { PresetService } = require('../../server-plugin/src/services/preset');
const { MetadataStore } = require('../../server-plugin/src/services/metadata');
const { StorageService } = require('../../server-plugin/src/services/storage');
const { GenerationService } = require('../../server-plugin/src/services/generation');
const { GalleryService } = require('../../server-plugin/src/services/gallery');
const adapter = require('../../server-plugin/src/adapters/openai-images');

async function waitForAttempt(metadata, attemptId) {
  for (let index = 0; index < 200; index += 1) {
    const attempt = metadata.getAttempt(attemptId);
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(attempt.status)) return attempt;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('attempt timeout');
}

async function fixture(t) {
  const upstream = await startMockUpstream();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stia-integration-'));
  const preset = await new PresetService(root).initialize();
  await preset.updateSettings({ allowHttp: true });
  await preset.update({
    baseUrl: upstream.baseUrl,
    apiKey: 'sk-test',
    selectedModel: 'gpt-image-1',
  });
  const metadata = await new MetadataStore(root).initialize();
  const storage = await new StorageService(root, () => preset.getSettings()).initialize();
  const generation = new GenerationService({ preset, metadata, storage });
  const gallery = new GalleryService({ metadata, storage });
  t.after(async () => {
    await upstream.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });
  return { upstream, root, preset, metadata, storage, generation, gallery };
}

function request(prompt, overrides = {}) {
  const tagId = overrides.tagId || crypto.randomUUID();
  return {
    tagId,
    attemptId: overrides.attemptId || crypto.randomUUID(),
    requestMode: overrides.requestMode || 'manual',
    prompt,
    chatId: 'chat-1',
    messageUuid: crypto.randomUUID(),
    tagOrdinal: 0,
    parameters: { count: prompt === 'multi' ? 2 : 1 },
  };
}

test('URL 返回会立即下载并保存本地', async t => {
  const f = await fixture(t);
  const input = request('url');
  await f.generation.generate(input);
  const attempt = await waitForAttempt(f.metadata, input.attemptId);
  assert.equal(attempt.status, 'succeeded');
  const result = f.metadata.getResult(attempt.resultIds[0]);
  assert.equal(result.sourceType, 'url');
  assert.ok((await fs.stat(f.storage.resolve(result.localRelativePath))).size > 0);
});

test('Base64 与多图返回都会保存', async t => {
  const f = await fixture(t);
  const base64Input = request('base64');
  await f.generation.generate(base64Input);
  assert.equal((await waitForAttempt(f.metadata, base64Input.attemptId)).resultIds.length, 1);
  const multiInput = request('multi');
  await f.generation.generate(multiInput);
  assert.equal((await waitForAttempt(f.metadata, multiInput.attemptId)).resultIds.length, 2);
});

test('重复 attemptId 服务端幂等且只调用一次上游', async t => {
  const f = await fixture(t);
  const input = request('base64');
  await Promise.all([
    f.generation.generate(input),
    f.generation.generate(input),
    f.generation.generate(input),
  ]);
  const attempt = await waitForAttempt(f.metadata, input.attemptId);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(f.upstream.state.generationCalls, 1);
});

test('401/429/500/错误 JSON 被映射为失败状态', async t => {
  const f = await fixture(t);
  for (const [prompt, expected] of [
    ['401', 'UPSTREAM_AUTH_FAILED'],
    ['429', 'UPSTREAM_RATE_LIMITED'],
    ['500', 'UPSTREAM_HTTP_ERROR'],
    ['bad-json', 'UPSTREAM_RESPONSE_INVALID'],
  ]) {
    const input = request(prompt);
    await f.generation.generate(input);
    const attempt = await waitForAttempt(f.metadata, input.attemptId);
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.errorCode, expected);
  }
});

test('模型拉取成功、失败保留旧缓存', async t => {
  const f = await fixture(t);
  const preset = await f.preset.get();
  const settings = await f.preset.getSettings();
  const models = await adapter.listModels({ preset, apiKey: 'sk-test', settings });
  assert.deepEqual(models, [{ id: 'gpt-image-1', ownedBy: 'mock' }]);
  await assert.rejects(
    adapter.listModels({ preset, apiKey: 'wrong', settings }),
    error => error.code === 'UPSTREAM_AUTH_FAILED',
  );
});

test('上游超时映射为可重试中文错误', async t => {
  const f = await fixture(t);
  const preset = { ...(await f.preset.get()), timeoutMs: 20 };
  const settings = await f.preset.getSettings();
  await assert.rejects(
    adapter.generate({
      preset,
      apiKey: 'sk-test',
      settings,
      prompt: 'timeout',
      parameters: { count: 1 },
    }),
    error => error.code === 'UPSTREAM_TIMEOUT' && error.retryable === true,
  );
});

test('重启时执行中 attempt 恢复为 interrupted，绝不重发', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stia-restart-'));
  const metadataDirectory = path.join(root, 'metadata');
  await fs.mkdir(metadataDirectory, { recursive: true });
  const attemptId = crypto.randomUUID();
  await fs.writeFile(path.join(metadataDirectory, 'index.json'), JSON.stringify({
    schemaVersion: 1,
    tags: {},
    results: {},
    attempts: {
      [attemptId]: {
        attemptId,
        status: 'generating',
        errorCode: null,
        errorMessage: null,
        completedAt: null,
      },
    },
  }));
  const store = await new MetadataStore(root).initialize();
  assert.equal(store.getAttempt(attemptId).status, 'interrupted');
  assert.equal(store.getAttempt(attemptId).errorCode, 'ATTEMPT_INTERRUPTED');
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
});

test('metadata 丢失时可从 images 目录重建画廊索引', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stia-rebuild-'));
  const resultId = crypto.randomUUID();
  const imageDirectory = path.join(root, 'images', '2026', '07');
  await fs.mkdir(imageDirectory, { recursive: true });
  await fs.writeFile(
    path.join(imageDirectory, `${resultId}.png`),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'),
  );
  const store = await new MetadataStore(root).initialize();
  assert.equal(store.getResult(resultId).status, 'available');
  assert.equal(store.getResult(resultId).recovered, true);
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
});

test('画廊删除移除文件并保留墓碑与 autoSuppressed', async t => {
  const f = await fixture(t);
  const input = request('base64');
  await f.generation.generate(input);
  const attempt = await waitForAttempt(f.metadata, input.attemptId);
  const resultId = attempt.resultIds[0];
  const file = f.storage.resolve(f.metadata.getResult(resultId).localRelativePath);
  await f.gallery.delete(resultId);
  await assert.rejects(fs.stat(file), error => error.code === 'ENOENT');
  assert.equal(f.metadata.getResult(resultId).status, 'deleted');
  assert.equal(f.metadata.getTag(input.tagId).autoSuppressed, true);
});

test('原图查看使用 inline 响应，兼容下载端点仍使用 attachment', async t => {
  const f = await fixture(t);
  const input = request('base64');
  await f.generation.generate(input);
  const attempt = await waitForAttempt(f.metadata, input.attemptId);
  const resultId = attempt.resultIds[0];

  async function streamHeaders(download) {
    const headers = {};
    const response = new Writable({ write(_chunk, _encoding, done) { done(); } });
    response.type = value => { headers['content-type'] = value; };
    response.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
    f.gallery.stream(resultId, response, download);
    await finished(response);
    return headers;
  }

  assert.match((await streamHeaders(false))['content-disposition'], /^inline;/);
  assert.match((await streamHeaders(true))['content-disposition'], /^attachment;/);
});
