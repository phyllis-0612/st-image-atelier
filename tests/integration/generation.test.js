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

test('服务器模式临时提示词只改本次请求与结果快照，不改原标签', async t => {
  const f = await fixture(t);
  const first = request('original prompt');
  await f.generation.generate(first);
  await waitForAttempt(f.metadata, first.attemptId);
  const originalTagPrompt = f.metadata.getTag(first.tagId).prompt;

  const redraw = request('temporary changed prompt', { tagId: first.tagId });
  await f.generation.generate(redraw);
  const attempt = await waitForAttempt(f.metadata, redraw.attemptId);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(f.upstream.state.generationBodies.at(-1).prompt, 'temporary changed prompt');
  assert.equal(f.metadata.getTag(first.tagId).prompt, originalTagPrompt);
  assert.equal(f.metadata.getResult(attempt.resultIds[0]).promptSnapshot, 'temporary changed prompt');
});

test('服务器模式收藏状态持久化，并保护收藏图片不被自动清理', async t => {
  const f = await fixture(t);
  const generated = [];
  for (let index = 0; index < 3; index += 1) {
    const input = request('base64');
    await f.generation.generate(input);
    const attempt = await waitForAttempt(f.metadata, input.attemptId);
    generated.push(attempt.resultIds[0]);
  }
  await f.metadata.transaction(index => {
    generated.forEach((resultId, position) => {
      index.results[resultId].createdAt = new Date(Date.now() - (10 - position) * 86_400_000).toISOString();
    });
  });
  await f.gallery.setFavorite(generated[0], true);
  assert.equal(f.metadata.getResult(generated[0]).favorite, true);
  assert.equal(f.gallery.metadataList().items.length, 3);
  await f.preset.updateSettings({ galleryCleanupByCount: true, galleryMaxCount: 1 });
  const cleanup = await f.gallery.cleanup(await f.preset.getSettings());
  assert.equal(cleanup.deletedCount, 2);
  assert.equal(f.metadata.getResult(generated[0]).status, 'available');
  assert.equal(f.metadata.getResult(generated[0]).favorite, true);
  const reloaded = await new MetadataStore(f.root).initialize();
  assert.equal(reloaded.getResult(generated[0]).favorite, true);
});

test('服务器智能重试只回退一次并记录元数据；关闭时不额外请求', async t => {
  const f = await fixture(t);
  await f.preset.updateSettings({ enableSmartRetry: true });
  const autoTagId = crypto.randomUUID();
  const successInput = request('reject-size', {
    tagId: autoTagId,
    attemptId: `auto:${autoTagId}`,
    requestMode: 'auto',
  });
  const beforeSuccess = f.upstream.state.generationCalls;
  await f.generation.generate(successInput);
  const successAttempt = await waitForAttempt(f.metadata, successInput.attemptId);
  assert.equal(successAttempt.status, 'succeeded');
  assert.equal(f.upstream.state.generationCalls - beforeSuccess, 2);
  assert.deepEqual(successAttempt.compatibilityRetry.adjustedParameters, ['size']);
  assert.equal('size' in f.upstream.state.generationBodies.at(-1), false);
  assert.deepEqual(
    f.metadata.getResult(successAttempt.resultIds[0]).compatibilityRetry.adjustedParameters,
    ['size'],
  );

  const failInput = request('reject-size-twice');
  const beforeFail = f.upstream.state.generationCalls;
  await f.generation.generate(failInput);
  const failed = await waitForAttempt(f.metadata, failInput.attemptId);
  assert.equal(failed.status, 'failed');
  assert.equal(f.upstream.state.generationCalls - beforeFail, 2);
  assert.match(failed.errorMessage, /已尝试移除 size 后重试一次/);

  await f.preset.updateSettings({ enableSmartRetry: false });
  const offInput = request('reject-size');
  const beforeOff = f.upstream.state.generationCalls;
  await f.generation.generate(offInput);
  assert.equal((await waitForAttempt(f.metadata, offInput.attemptId)).status, 'failed');
  assert.equal(f.upstream.state.generationCalls - beforeOff, 1);
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

test('服务器模式持久化两个新开关，旧设置默认关闭', async t => {
  const f = await fixture(t);
  let settings = await f.preset.getSettings();
  assert.equal(settings.enablePromptOverrideRegenerate, false);
  assert.equal(settings.enableSmartRetry, false);
  await f.preset.updateSettings({
    enablePromptOverrideRegenerate: true,
    enableSmartRetry: true,
  });
  const reloaded = await new PresetService(f.root).initialize();
  settings = await reloaded.getSettings();
  assert.equal(settings.enablePromptOverrideRegenerate, true);
  assert.equal(settings.enableSmartRetry, true);
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
  assert.equal(store.getResult(resultId).favorite, false);
  assert.equal(store.getResult(resultId).promptSnapshot, '从本地图片目录恢复的记录');
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

test('服务端画廊按时间和数量规则自动清理最旧图片', async t => {
  const f = await fixture(t);
  const generated = [];
  for (let index = 0; index < 4; index += 1) {
    const input = request('base64');
    await f.generation.generate(input);
    const attempt = await waitForAttempt(f.metadata, input.attemptId);
    generated.push({ input, resultId: attempt.resultIds[0] });
  }
  const currentTime = Date.now();
  const ages = [10, 5, 2, 1];
  await f.metadata.transaction(index => {
    generated.forEach((item, position) => {
      index.results[item.resultId].createdAt = new Date(
        currentTime - ages[position] * 24 * 60 * 60 * 1000,
      ).toISOString();
    });
  });
  const removedFiles = generated.slice(0, 2)
    .map(item => f.storage.resolve(f.metadata.getResult(item.resultId).localRelativePath));
  const keptFiles = generated.slice(2)
    .map(item => f.storage.resolve(f.metadata.getResult(item.resultId).localRelativePath));
  await f.preset.updateSettings({
    galleryCleanupByAge: true,
    galleryMaxAgeDays: 7,
    galleryCleanupByCount: true,
    galleryMaxCount: 2,
  });
  const cleanup = await f.gallery.cleanup(await f.preset.getSettings());
  assert.equal(cleanup.deletedCount, 2);
  assert.equal(cleanup.keptCount, 2);
  assert.equal(cleanup.byAgeCount, 1);
  assert.equal(cleanup.byCountCount, 2);
  for (const file of removedFiles) {
    await assert.rejects(fs.stat(file), error => error.code === 'ENOENT');
  }
  for (const file of keptFiles) assert.ok((await fs.stat(file)).size > 0);
  for (const item of generated.slice(0, 2)) {
    assert.equal(f.metadata.getResult(item.resultId).status, 'deleted');
    assert.equal(f.metadata.getTag(item.input.tagId).autoSuppressed, true);
  }
});
