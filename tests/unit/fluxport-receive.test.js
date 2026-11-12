import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveImageResponse } from '../../src/shared/openai-image-response.js';
import { DirectError, fetchJson, generateImages, recoverFluxPortImages } from '../../src/ui/api/openai-direct.js';
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

// 先正常传一段，然后只剩零星字节：连接不断，但永远收不完。
function trickle(head, signal) {
  const encoder = new TextEncoder();
  let timer;
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(head));
      timer = setInterval(() => controller.enqueue(encoder.encode('A')), 10);
      signal?.addEventListener('abort', () => { clearInterval(timer); try { controller.error(signal.reason); } catch { /* closed */ } }, { once: true });
    },
    cancel() { clearInterval(timer); },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const stalledSync = '{"task_id":"imgtask_abc","execution_mode":"sync","data":[{"b64_json":"' + 'A'.repeat(2000);

test('同步回包传输停滞：放弃这条连接，按回包开头的任务号重读原任务，生图只提交一次', async t => {
  const fetchBefore = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchBefore; });
  const calls = [];
  const notices = [];
  const progress = [];
  globalThis.fetch = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    if (init.method === 'POST') return trickle(stalledSync, init.signal);
    return Response.json(inline);
  };
  const sources = await generateImages({
    preset: preset({ extraBody: { async: false }, timeoutMs: 60_000 }), apiKey: 'test-key', prompt: 'a cat', parameters: {},
    settings: { enableSmartRetry: true }, retryDelays: [0, 0, 0], stallMs: 1300,
    onPolling: message => notices.push(message), onReceive: value => progress.push(value),
  });
  assert.equal(sources[0].value, PNG_BASE64);
  assert.deepEqual(calls, ['POST /v1/images/generations', 'GET /v1/images/tasks/imgtask_abc']);
  assert.deepEqual(notices, ['回包传输停滞，正在换一条连接读取原任务（不重新生图）']);
  assert.ok(progress.some(item => item.receiving && typeof item.speed === 'number'), '接收中报告当前速度');
});

test('停滞的回包开头没有任务号时停止并指路；非流港站点不因停滞中断', async t => {
  const fetchBefore = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchBefore; });
  let posts = 0;
  globalThis.fetch = async (_url, init) => { posts++; return trickle('{"data":[{"b64_json":"' + 'A'.repeat(2000), init.signal); };
  await assert.rejects(generateImages({
    preset: preset({ extraBody: { async: false }, timeoutMs: 60_000 }), apiKey: 'test-key', prompt: 'a cat', parameters: {},
    settings: { enableSmartRetry: true }, retryDelays: [0, 0, 0], stallMs: 80,
  }), error => /传输停滞/.test(error.message) && /找回流港图片/.test(error.message) && /导入原图/.test(error.message)
    && error.retryable === false);
  assert.equal(posts, 1);
  // 其他中转站没有“重读原任务”的办法，慢也只能继续等，由用户决定是否取消。
  const controller = new AbortController();
  const other = generateImages({
    preset: preset({ baseUrl: 'https://relay.example.com/v1', timeoutMs: 60_000 }), apiKey: 'test-key', prompt: 'a cat',
    parameters: {}, settings: {}, stallMs: 80, signal: controller.signal,
  });
  const outcome = await Promise.race([other.then(() => 'done', () => 'failed'), pause(400).then(() => 'still waiting')]);
  assert.equal(outcome, 'still waiting');
  controller.abort(new Error('cancelled'));
  await assert.rejects(other);
});

test('找回：只读原任务；连续三条连接都停滞就停下并说明，不无限重连', async t => {
  const fetchBefore = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchBefore; });
  const calls = [];
  let timing;
  globalThis.fetch = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    return calls.length < 3 ? trickle('{"status":"completed","data":[{"b64_json":"' + 'A'.repeat(2000), init.signal)
      : Response.json({ ...inline, padding: 'x'.repeat(70_000) });
  };
  const sources = await recoverFluxPortImages({
    preset: preset(), apiKey: 'test-key', taskId: 'imgtask_abc', stallMs: 80, onTiming: value => { timing = value; },
  });
  assert.equal(sources[0].value, PNG_BASE64);
  assert.deepEqual(calls, Array(3).fill('GET /v1/images/tasks/imgtask_abc'));
  assert.ok(timing.receiveBytes > 70_000);

  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push(init.method);
    return trickle('{"status":"completed","data":[{"b64_json":"' + 'A'.repeat(2000), init.signal);
  };
  await assert.rejects(recoverFluxPortImages({ preset: preset(), apiKey: 'test-key', taskId: 'imgtask_abc', stallMs: 80 }),
    error => /连续 3 次连接都在传输中停滞/.test(error.message) && /换 API 域名或开代理/.test(error.message));
  assert.deepEqual(calls, ['GET', 'GET', 'GET']);

  globalThis.fetch = async () => Response.json({ error: { message: 'task not found' } }, { status: 404 });
  await assert.rejects(recoverFluxPortImages({ preset: preset(), apiKey: 'test-key', taskId: 'imgtask_abc' }),
    /找回图片失败（HTTP 404）：流港没有找到这个任务/);
  globalThis.fetch = async () => assert.fail('不应请求');
  await assert.rejects(recoverFluxPortImages({ preset: preset({ baseUrl: 'https://relay.example.com/v1' }), apiKey: 'k', taskId: 'imgtask_abc' }), /流港预设/);
  await assert.rejects(recoverFluxPortImages({ preset: preset(), apiKey: 'k', taskId: '../x' }), /完整的流港图片任务 ID/);
});

test('取图有进展就不掐断：慢但在动的下载可以超过独立时限，停住的仍按时限结束', async () => {
  const receipt = { task_id: 'imgtask_1', status_url: '/v1/images/tasks/imgtask_1?view=summary', assets: [] };
  const request = moving => async (url, signal, kind) => {
    if (url.includes('view=summary')) return { status: 'completed', assets: [] };
    for (let step = 0; step < 6; step++) {
      await Promise.race([pause(40), untilAbort(signal)]);
      if (moving) kind.touch();
    }
    return inline;
  };
  const images = await resolveImageResponse(receipt, options({ resultTimeoutMs: 100, request: request(true) }));
  assert.equal(images[0].value, PNG_BASE64);
  await assert.rejects(resolveImageResponse(receipt, options({ resultTimeoutMs: 100, request: request(false) })),
    error => error.code === 'UPSTREAM_TIMEOUT');
  // 没有摘要地址时，状态查询本身就是那次大下载，同样适用。
  const direct = await resolveImageResponse({ task_id: 'imgtask_1', execution_mode: 'async', assets: [] }, options({
    deadline: Date.now() + 20, resultTimeoutMs: 100,
    request: async (_url, signal, kind) => {
      for (let step = 0; step < 6; step++) { await Promise.race([pause(40), untilAbort(signal)]); kind.touch(); }
      return inline;
    },
  }));
  assert.equal(direct[0].value, PNG_BASE64);
});

test('独立取图时限不会越过总等待上限', async () => {
  await assert.rejects(resolveImageResponse({
    task_id: 'imgtask_1', status: 'completed', assets: [],
  }, options({ maxWaitMs: 60, resultTimeoutMs: 2000, keepWaiting: true,
    request: (_url, signal) => untilAbort(signal),
  })), error => error.code === 'UPSTREAM_TIMEOUT');
});
