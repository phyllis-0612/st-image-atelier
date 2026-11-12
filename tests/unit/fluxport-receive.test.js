import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveImageResponse } from '../../src/shared/openai-image-response.js';
import { DirectError, fetchJson, generateImages } from '../../src/ui/api/openai-direct.js';
import { imageTimingBreakdown } from '../../src/ui/media/image-metadata.js';
import { PNG_BASE64 } from '../mocks/mock-upstream.js';

const endpoint = 'https://api.uselg.top/v1/images/generations';
const link = 'https://download.ai-media.vip/signed/1.png';
const inline = { status: 'completed', data: [{ b64_json: PNG_BASE64 }] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const untilAbort = signal => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

function options(overrides = {}) {
  return {
    endpoint, apiKey: 'test-key', deadline: Date.now() + 60_000, sleep: async () => {},
    makeError: (code, details, status) => new DirectError(code, details, status, false, details),
    ...overrides,
  };
}

function preset(extra = {}) {
  return {
    baseUrl: 'https://api.uselg.top/v1', generationPath: '/v1/images/generations',
    selectedModel: 'image', timeoutMs: 1000, ...extra,
  };
}

// A body that arrives in pieces and, unless `close` is set, is never ended by the gateway.
function streamed(parts, { close = false, fail = false, gapMs = 0 } = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      for (const part of parts) {
        if (gapMs) await pause(gapMs);
        controller.enqueue(encoder.encode(part));
      }
      if (fail) { await pause(15); controller.error(new TypeError('network error')); }
      else if (close) controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('同步回包晚于预设超时才到，手里已有的图片不会被当作超时丢掉', async () => {
  const receipt = { task_id: 'imgtask_1', execution_mode: 'sync', status: 'completed', assets: [{ signed_url: link }] };
  // 完整内嵌结果拿得到就用内嵌图。
  const upgraded = await resolveImageResponse(receipt, options({
    deadline: Date.now() - 1, preferInline: true, request: async () => inline,
  }));
  assert.equal(upgraded[0].value, PNG_BASE64);
  // 拿不到也保留回包里的链接，而不是报“超过预设等待时间”。
  const kept = await resolveImageResponse(receipt, options({
    deadline: Date.now() - 1, preferInline: true, request: async () => { throw new Error('unavailable'); },
  }));
  assert.equal(kept[0].value, link);
});

test('任务画完后取图有独立时限，不被排队和出图耗掉的预设超时掐断', async () => {
  const slowResult = async () => { await pause(150); return inline; }; // 完整结果传得比剩余的预设时间久
  // 流港回执带摘要查询地址：摘要说画完了，再取完整结果。
  const calls = [];
  const viaSummary = await resolveImageResponse({
    task_id: 'imgtask_1', execution_mode: 'async', status_url: '/v1/images/tasks/imgtask_1?view=summary', assets: [],
  }, options({
    deadline: Date.now() + 40, resultTimeoutMs: 2000,
    request: async (url, _signal, kind) => {
      calls.push(kind.result);
      return url.includes('view=summary') ? { status: 'completed', assets: [] } : slowResult();
    },
  }));
  assert.equal(viaSummary[0].value, PNG_BASE64);
  assert.deepEqual(calls, [false, true]);
  // 没有摘要地址：状态查询本身就带回整张内嵌图，同样不能在传输途中被掐断。
  const direct = await resolveImageResponse({ task_id: 'imgtask_1', execution_mode: 'async', assets: [] }, options({
    deadline: Date.now() + 40, resultTimeoutMs: 2000, request: slowResult,
  }));
  assert.equal(direct[0].value, PNG_BASE64);
});

test('取图时限用完才放弃；用户取消立即停止', async () => {
  const receipt = { task_id: 'imgtask_1', status_url: '/v1/images/tasks/imgtask_1?view=summary', assets: [] };
  const request = async (url, signal) => url.includes('view=summary')
    ? { status: 'completed', assets: [] } : untilAbort(signal);
  const started = Date.now();
  await assert.rejects(resolveImageResponse(receipt, options({ deadline: Date.now() + 20, resultTimeoutMs: 120, request })),
    error => error.code === 'UPSTREAM_TIMEOUT');
  assert.ok(Date.now() - started >= 100);
  const controller = new AbortController();
  const reason = new Error('用户取消');
  setTimeout(() => controller.abort(reason), 20);
  await assert.rejects(resolveImageResponse(receipt, options({ signal: controller.signal, request })), error => error === reason);
});

test('开启“超时后继续等待”时，异步排队超过预设时间只提醒一次并继续查询', async () => {
  const receipt = { task_id: 'imgtask_1', execution_mode: 'async', status: 'queued', assets: [] };
  let polls = 0;
  let reminders = 0;
  const request = async () => {
    polls++;
    await pause(15);
    return polls < 6 ? { status: 'processing', assets: [] } : { status: 'completed', data: [{ b64_json: PNG_BASE64 }], assets: [] };
  };
  const images = await resolveImageResponse(receipt, options({
    deadline: Date.now() + 30, keepWaiting: true, onDeadline: () => { reminders++; }, request,
  }));
  assert.equal(images[0].value, PNG_BASE64);
  assert.equal(reminders, 1);
  polls = 0;
  await assert.rejects(resolveImageResponse(receipt, options({ deadline: Date.now() + 30, request })),
    error => error.code === 'UPSTREAM_TIMEOUT');
});

test('结果未确认且站方禁止查询和重试时，如实提示并且不发任何后续请求', async t => {
  const uncertain = {
    assets: [], status: 'uncertain', auto_poll: false, retryable: false,
    error_code: 'image_result_uncertain', error_message: 'upstream returned HTTP 408',
  };
  await assert.rejects(resolveImageResponse(uncertain, options({ request: async () => assert.fail('不应查询') })), error => {
    assert.match(error.message, /没能确认这次生图的结果（image_result_uncertain）：upstream returned HTTP 408/);
    assert.doesNotMatch(error.message, /返回格式不兼容|没有可识别的图片/);
    assert.equal(error.retryable, false);
    return true;
  });
  await assert.rejects(resolveImageResponse({ task_id: 'imgtask_1', ...uncertain }, options({
    request: async () => assert.fail('不应查询'),
  })), /没能确认这次生图的结果/);

  // 同样的回包以 HTTP 错误状态返回：即使开了智能重试，也只提交一次。
  const fetchBefore = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchBefore; });
  for (const status of [200, 408, 502]) {
    let posts = 0;
    globalThis.fetch = async () => { posts++; return Response.json(uncertain, { status }); };
    await assert.rejects(generateImages({
      preset: preset(), apiKey: 'test-key', prompt: 'a cat', parameters: {},
      settings: { enableSmartRetry: true }, retryDelays: [0, 0, 0],
    }), error => /没能确认这次生图的结果/.test(error.message) && error.retryable === false);
    assert.equal(posts, 1, `HTTP ${status}`);
  }
});

test('收到完整 JSON 立即返回，不等连接结束；保活空白不算图片数据', async t => {
  const fetchBefore = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchBefore; });
  const body = JSON.stringify({ data: [{ b64_json: PNG_BASE64, note: 'brace } and quote \\" inside' }] });
  const progress = [];
  let timing;
  globalThis.fetch = async () => streamed(['  \n', ' ', body.slice(0, 40), body.slice(40)], { gapMs: 20 });
  const payload = await fetchJson(endpoint, { method: 'POST', headers: {} }, 0, {
    streamBody: true, onReceive: value => progress.push(value), onTiming: value => { timing = value; },
  });
  assert.equal(payload.data[0].b64_json, PNG_BASE64);
  assert.equal(progress[0].receiving, false);
  assert.equal(progress.find(item => item.bytes === 4)?.receiving, false, '只有保活空白时仍是等待出图');
  assert.equal(progress.at(-1).receiving, true);
  assert.ok(timing.headersMs >= 40 && timing.bytes === body.length + 4);
  globalThis.fetch = async () => streamed(['<html>bad gateway</html>'], { close: true });
  await assert.rejects(fetchJson(endpoint, { method: 'GET', headers: {} }, 0, { streamBody: true }),
    error => error.code === 'UPSTREAM_RESPONSE_INVALID' && error.message.includes('bad gateway'));
});

test('生图请求已被接单后连接中断：不重发生图，并说明收到了多少', async t => {
  const fetchBefore = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchBefore; });
  const body = JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] });
  for (const [parts, pattern] of [
    [[body.slice(0, 30)], /图片数据没有收完（\d+ 秒收到 0\.0 MB 后中断）/],
    [[' '], /已接单，但连接在等待出图 \d+ 秒后中断/],
  ]) {
    let posts = 0;
    globalThis.fetch = async () => { posts++; return streamed(parts, { fail: true }); };
    await assert.rejects(generateImages({
      preset: preset({ extraBody: { async: false } }), apiKey: 'test-key', prompt: 'a cat', parameters: {},
      settings: { enableSmartRetry: true }, retryDelays: [0, 0, 0],
    }), error => pattern.test(error.message) && error.retryable === false && /不要急着重绘/.test(error.message));
    assert.equal(posts, 1);
  }
});

test('异步取图中途断流只重读原任务，生图请求始终只提交一次，并记录各阶段用时', async t => {
  const fetchBefore = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchBefore; });
  const big = JSON.stringify({ status: 'completed', data: [{ b64_json: PNG_BASE64 }], padding: 'x'.repeat(70_000) });
  const calls = [];
  const received = [];
  let timing;
  globalThis.fetch = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    if (init.method === 'POST') {
      assert.equal(JSON.parse(init.body).async, true);
      return Response.json({ task_id: 'imgtask_1', execution_mode: 'async', status: 'queued', assets: [], poll_after_ms: 1 }, { status: 202 });
    }
    const gets = calls.filter(call => call.startsWith('GET')).length;
    if (gets === 1) return streamed([big.slice(0, 1000)], { fail: true });
    return streamed([big.slice(0, 30_000), big.slice(30_000)], { gapMs: 10 });
  };
  const sources = await generateImages({
    preset: preset(), apiKey: 'test-key', prompt: 'a cat', parameters: {}, settings: {},
    onReceive: value => received.push(value), onTiming: value => { timing = value; },
  });
  assert.equal(sources[0].value, PNG_BASE64);
  assert.deepEqual(calls, ['POST /v1/images/generations', 'GET /v1/images/tasks/imgtask_1', 'GET /v1/images/tasks/imgtask_1']);
  assert.ok(received.some(item => item.receiving && item.bytes >= 30_000));
  assert.equal(timing.receiveBytes, big.length);
  assert.ok(timing.waitMs >= 0 && timing.receiveMs >= 0);
});

test('用时拆分文字', () => {
  assert.equal(imageTimingBreakdown({ transferTiming: { waitMs: 118_200, receiveMs: 131_000, receiveBytes: 6.2 * 1048576, saveMs: 2600 } }),
    '等回包 118 秒 · 收图 131 秒（6.2 MB） · 保存 3 秒');
  assert.equal(imageTimingBreakdown({ transferTiming: { waitMs: 1000, receiveMs: 0, receiveBytes: 0 } }), '等回包 1 秒 · 收图 0 秒');
  assert.equal(imageTimingBreakdown({}), '');
  assert.equal(imageTimingBreakdown({ transferTiming: { waitMs: 'x' } }), '');
});

test('开启继续等待时，已完成任务的取图仍只使用独立时限', async () => {
  const started = Date.now();
  await assert.rejects(resolveImageResponse({
    task_id: 'imgtask_1', status: 'completed', assets: [],
  }, options({ deadline: Date.now() + 60_000, keepWaiting: true,
    resultTimeoutMs: 40, request: (_url, signal) => untilAbort(signal),
  })), error => error.code === 'UPSTREAM_TIMEOUT');
  assert.ok(Date.now() - started < 1000);
});

test('长错误回包的停止标记仍被识别，提示不会暴露 Key，也不自动重发', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const apiKey = 'arbitrary-private-token';
  for (const status of [200, 502]) {
    let count = 0;
    globalThis.fetch = async () => {
      count++;
      return Response.json({ padding: 'x'.repeat(2000), status: 'uncertain',
        error_code: 'image_result_uncertain', error: 'upstream echoed ' + apiKey,
        auto_poll: false, retryable: false }, { status });
    };
    await assert.rejects(generateImages({ preset: preset({ extraBody: { async: false } }),
      apiKey, prompt: 'cat', parameters: {}, settings: { enableSmartRetry: true },
      retryDelays: [0, 0, 0],
    }), error => error.retryable === false && !error.message.includes(apiKey)
      && error.message.includes('没能确认这次生图的结果'));
    assert.equal(count, 1);
  }
});
