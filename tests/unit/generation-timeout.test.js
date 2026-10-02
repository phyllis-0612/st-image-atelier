import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startGenerationTimeout } from '../../src/shared/generation-timeout.js';
import { generateImages } from '../../src/ui/api/openai-direct.js';
import { generateNovelAiImages } from '../../src/ui/api/novelai-direct.js';
import { DEFAULT_NOVELAI_CONFIG } from '../../src/shared/constants.js';
import { PNG_BASE64 } from '../mocks/mock-upstream.js';

const require = createRequire(import.meta.url);
const server = require('../../server-plugin/src/utils/generation-timeout');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const [name, start] of [['浏览器', startGenerationTimeout], ['服务端', server.startGenerationTimeout]]) {
  test(`${name}等待提醒不会中断；明确关闭继续等待时仍有硬超时`, async () => {
    const controller = new AbortController();
    let reminders = 0;
    const clear = start({ controller, timeoutMs: 5, keepWaiting: true, onTimeout: () => reminders++ });
    await pause(20);
    assert.equal(reminders, 1);
    assert.equal(controller.signal.aborted, false);
    clear();
    const hard = new AbortController();
    const clearHard = start({ controller: hard, timeoutMs: 5 });
    await pause(20);
    assert.equal(hard.signal.aborted, true);
    clearHard();
  });
}

for (const provider of ['openai', 'novelai']) {
  test(`${provider}超过提醒时间仍接收迟到图片，等待期间不会自动重发`, async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let calls = 0;
    let reminder;
    const reachedReminder = new Promise(resolve => { reminder = resolve; });
    let finish;
    const response = new Promise(resolve => { finish = resolve; });
    let signal;
    globalThis.fetch = async (_url, options) => { calls++; signal = options.signal; return response; };
    const settings = { enableSmartRetry: true, maxImageBytes: 1024 * 1024 };
    const controller = new AbortController();
    const generate = provider === 'openai' ? generateImages : generateNovelAiImages;
    const work = generate({
      preset: { baseUrl: 'https://example.com', generationPath: '/v1/images/generations', selectedModel: 'image', timeoutMs: 5 },
      config: { ...DEFAULT_NOVELAI_CONFIG, baseUrl: 'https://example.com', generationPath: '/ai/generate-image', model: 'nai-diffusion-4-5-full', timeoutMs: 5 },
      apiKey: 'test-key', prompt: 'test', parameters: {}, settings,
      signal: controller.signal, onTimeout: reminder,
    });
    await reachedReminder;
    assert.equal(signal.aborted, false);
    assert.equal(calls, 1);
    finish(new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), { headers: { 'Content-Type': 'application/json' } }));
    const result = await work;
    assert.equal((result.sources || result).length, 1);
    assert.equal(calls, 1);
  });
}
