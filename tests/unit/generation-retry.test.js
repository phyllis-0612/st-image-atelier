import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runGenerationWithRetry, waitForRetry } from '../../src/shared/generation-retry.js';
import { createGenerationNotifications } from '../../src/ui/state/generation-notifications.js';
import { generateImages } from '../../src/ui/api/openai-direct.js';
import { DEFAULT_PRESET } from '../../src/shared/constants.js';

const require = createRequire(import.meta.url);
const serverRetry = require('../../server-plugin/src/utils/generation-retry');
const serverAdapter = require('../../server-plugin/src/adapters/openai-images');
const transient = () => Object.assign(new Error('HTTP 502'), { code: 'UPSTREAM_HTTP_ERROR', retryable: true });

for (const [name, run] of [['直连', runGenerationWithRetry], ['服务端', serverRetry.runGenerationWithRetry]]) {
  test(`${name}连续失败最多请求四次并报告三次重试`, async () => {
    let calls = 0;
    const notices = [];
    await assert.rejects(run({
      enabled: true, retryDelays: [0, 0, 0],
      request: async () => { calls += 1; throw transient(); },
      onRetry: notice => notices.push(notice.retryCount),
    }), error => error.autoRetryCount === 3);
    assert.equal(calls, 4);
    assert.deepEqual(notices, [1, 2, 3]);
  });

  test(`${name}重试成功立即结束，关闭开关和永久错误只请求一次`, async () => {
    let calls = 0;
    assert.equal(await run({
      enabled: true, retryDelays: [0, 0, 0],
      request: async () => { if (++calls < 3) throw transient(); return 'image'; },
    }), 'image');
    assert.equal(calls, 3);
    for (const [enabled, error] of [
      [false, transient()],
      [true, Object.assign(transient(), { message: 'insufficient quota' })],
      [true, Object.assign(transient(), { message: 'content policy rejected' })],
      [true, Object.assign(transient(), { code: 'LOCAL_SAVE_FAILED' })],
    ]) {
      calls = 0;
      await assert.rejects(run({ enabled, request: async () => { calls += 1; throw error; } }));
      assert.equal(calls, 1);
    }
  });

  test(`${name}重试等待时取消，不再向上游请求`, async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(run({
      enabled: true, signal: controller.signal,
      request: async () => { calls += 1; throw transient(); },
      onRetry: () => controller.abort(new Error('用户取消')),
    }), /用户取消/);
    assert.equal(calls, 1);
  });
}

test('等待中的重试计时器可立即取消', async () => {
  const controller = new AbortController();
  const waiting = waitForRetry(60_000, controller.signal);
  controller.abort(new Error('stop'));
  await assert.rejects(waiting, /stop/);
});

for (const [name, generate] of [['直连', generateImages], ['服务端', serverAdapter.generate]]) {
  test(`${name}参数回退与 502 共用三次预算，回退后的参数保持到后续请求`, async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return new Response(JSON.stringify({ error: { message: bodies.length === 1
        ? 'response_format is unsupported' : 'temporarily unavailable' } }), {
        status: bodies.length === 1 ? 400 : 502,
      });
    };
    await assert.rejects(generate({
      preset: { ...DEFAULT_PRESET, baseUrl: 'https://example.com', selectedModel: 'image' },
      apiKey: 'test', prompt: 'original', parameters: {},
      settings: { enableSmartRetry: true }, retryDelays: [0, 0, 0],
    }), error => error.autoRetryCount === 3 && Boolean(error.compatibilityRetry));
    assert.equal(bodies.length, 4);
    assert.equal(bodies[0].response_format, 'b64_json');
    for (const body of bodies.slice(1)) {
      assert.equal('response_format' in body, false);
      assert.equal(body.prompt, 'original');
      assert.equal(body.quality, DEFAULT_PRESET.defaultQuality);
    }
  });
}

test('重试横幅按轮次去重，最终失败仅通知一次且明确三次上限', () => {
  const banners = [];
  const notifications = createGenerationNotifications((...args) => banners.push(args));
  for (const count of [1, 1, 2, 2, 3, 3]) {
    notifications.progress({ status: 'generating', retryNotice: { retryCount: count, message: `重试 ${count}/3` } });
  }
  notifications.progress({ status: 'succeeded', retryNotice: { retryCount: 4, message: 'stale' } });
  notifications.failed(new Error('502'), 3);
  notifications.failed(new Error('502'), 3);
  assert.equal(banners.length, 4);
  assert.deepEqual(banners.map(value => value[0]), ['warning', 'warning', 'warning', 'error']);
  assert.match(banners[3][1], /自动重试已达 3 次，已停止/);
});

test('关闭重试时也能提示首次失败，并保留手动重试提示', () => {
  let banner;
  createGenerationNotifications((...args) => { banner = args; }).failed(new Error('失败'));
  assert.equal(banner[0], 'error');
  assert.match(banner[1], /手动重试/);
  assert.doesNotMatch(banner[1], /已达 3 次/);
});
