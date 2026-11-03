import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolveImageResponse } from '../../src/shared/openai-image-response.js';
import {
  DirectError,
  base64ToBytes,
  bytesToBase64,
  detectImageType,
  extractUpstreamError,
  fetchJson,
  generateImages,
  inspectBase64Image,
  normalizeImageSize,
  normalizeEndpoint,
  parseImageResponse,
  parseModelsResponse,
} from '../../src/ui/api/openai-direct.js';
import { PNG_BASE64 } from '../mocks/mock-upstream.js';

test('上传用图片头检验保留原始 Base64，不展开整张图片', () => {
  const inspected = inspectBase64Image(`data:image/png;base64,${PNG_BASE64}`);
  assert.equal(inspected.base64, PNG_BASE64);
  assert.equal(inspected.type.extension, 'png');
  assert.equal(inspected.byteSize, Buffer.from(PNG_BASE64, 'base64').length);
  assert.equal(inspectBase64Image(PNG_BASE64)?.base64, PNG_BASE64);
  assert.equal(inspectBase64Image('not-an-image'), null);
});

test('免服务端适配器规范化地址且不重复 /v1', () => {
  assert.equal(
    normalizeEndpoint('https://api.example.com/v1/', '/v1/images/generations'),
    'https://api.example.com/v1/images/generations',
  );
  assert.equal(
    normalizeEndpoint('https://api.example.com', '/v1/models'),
    'https://api.example.com/v1/models',
  );
});

test('尺寸参数统一使用英文小写 x', () => {
  assert.equal(normalizeImageSize('1024×1024'), '1024x1024');
  assert.equal(normalizeImageSize('1024 X 1536'), '1024x1536');
  assert.equal(normalizeImageSize('1536*1024'), '1536x1024');
  assert.equal(normalizeImageSize('auto'), 'auto');
});

test('生图请求在发送前修正 size 乘号', async t => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await generateImages({
    preset: {
      baseUrl: 'https://api.example.com',
      generationPath: '/v1/images/generations',
      selectedModel: 'image-model',
      sendSize: true,
      sendQuality: false,
      sendN: false,
      defaultSize: '1024×1024',
      extraBody: { size: '1024 × 1536' },
      timeoutMs: 1000,
    },
    apiKey: 'sk-test',
    prompt: 'test',
    parameters: {},
    settings: { allowHttp: false },
  });
  assert.equal(requestBody.size, '1024x1536');
});

test('免服务端适配器解析图片和模型响应', () => {
  assert.deepEqual(parseImageResponse({
    result: { data: [{ url: 'https://example.com/a.png', b64_json: 'base64' }] },
  }), [{ sourceType: 'base64', value: 'base64', generationIndex: 0 }]);
  assert.deepEqual(parseModelsResponse({ data: [{ id: 'gpt-image-1', owned_by: 'mock' }] }), [
    { id: 'gpt-image-1', ownedBy: 'mock' },
  ]);
  assert.throws(
    () => parseImageResponse({ data: [{ text: 'none' }] }),
    error => error instanceof DirectError && error.code === 'UPSTREAM_RESPONSE_INVALID',
  );
});

test('浏览器网络/CORS 失败映射为明确错误', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(
    fetchJson('https://api.example.com/v1/models', {}, 1000),
    error => error.code === 'DIRECT_FETCH_BLOCKED' && /浏览器连不上生图接口/.test(error.message),
  );
});

test('上游 HTTP 错误展示真实原因并隐藏密钥', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      message: 'Unsupported parameter: quality; Authorization: Bearer sk-secret-value',
    },
  }), { status: 400 });
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    fetchJson('https://api.example.com/v1/images/generations', {}, 1000),
    error => error.code === 'UPSTREAM_HTTP_ERROR'
      && /HTTP 400/.test(error.message)
      && /Unsupported parameter: quality/.test(error.message)
      && !/sk-secret-value/.test(error.message),
  );
  assert.equal(
    extractUpstreamError('{"detail":"generation path mismatch"}'),
    'generation path mismatch',
  );
});

test('上游内容审核拒绝显示针对性提示', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      message: 'Content was rejected by upstream moderation. Please adjust your input and try again.',
    },
  }), { status: 400 });
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    fetchJson('https://api.example.com/v1/images/generations', {}, 1000),
    error => error.code === 'UPSTREAM_HTTP_ERROR'
      && /内容审核拒绝/.test(error.message)
      && !/不发送/.test(error.message),
  );
});

test('浏览器 Base64 转换与图片 magic bytes 校验', () => {
  const bytes = base64ToBytes(PNG_BASE64);
  assert.equal(detectImageType(bytes)?.extension, 'png');
  assert.equal(bytesToBase64(bytes), PNG_BASE64);
});

/* 图片返回格式：默认请求 b64_json 内嵌返回（1.5.4） */
function presetFor(extra = {}) {
  return {
    baseUrl: 'https://api.example.com',
    generationPath: '/v1/images/generations',
    selectedModel: 'image-model',
    sendSize: false,
    sendQuality: false,
    sendN: false,
    timeoutMs: 1000,
    extraBody: {},
    ...extra,
  };
}

function captureFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    return handler(body, bodies.length);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return bodies;
}

const OK = () => new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), { status: 200 });

test('GPT 直连完整发送 32000 字符，超限和空提示词不会请求上游', async t => {
  const bodies = captureFetch(t, OK);
  const options = { preset: presetFor(), apiKey: 'sk-test', parameters: {}, settings: {} };
  const prompt = '画'.repeat(32_000);
  await generateImages({ ...options, prompt });
  assert.equal(bodies[0].prompt, prompt);
  await assert.rejects(generateImages({ ...options, prompt: 'x'.repeat(32_001) }),
    error => error.code === 'VALIDATION_FAILED' && /32000/.test(error.details));
  await assert.rejects(generateImages({ ...options, prompt: '   ' }),
    error => error.code === 'VALIDATION_FAILED');
  assert.equal(bodies.length, 1);
});

test('旧预设没有 responseFormat 字段时默认请求 b64_json', async t => {
  const bodies = captureFetch(t, OK);
  await generateImages({ preset: presetFor(), apiKey: 'sk', prompt: 'x', parameters: {}, settings: {} });
  assert.equal(bodies[0].response_format, 'b64_json');
});

test('responseFormat 可改为 url 或不发送；额外请求参数 JSON 优先级最高', async t => {
  const bodies = captureFetch(t, OK);
  await generateImages({ preset: presetFor({ responseFormat: 'url' }), apiKey: 'sk', prompt: 'x', parameters: {}, settings: {} });
  await generateImages({ preset: presetFor({ responseFormat: '' }), apiKey: 'sk', prompt: 'x', parameters: {}, settings: {} });
  await generateImages({
    preset: presetFor({ extraBody: { response_format: 'url' } }),
    apiKey: 'sk', prompt: 'x', parameters: {}, settings: {},
  });
  assert.equal(bodies[0].response_format, 'url');
  assert.equal('response_format' in bodies[1], false);
  assert.equal(bodies[2].response_format, 'url');
});

test('智能重试开启时，上游点名拒绝 response_format 才会去掉并重发一次', async t => {
  const bodies = captureFetch(t, (body, attempt) => {
    if ('response_format' in body) {
      return new Response(JSON.stringify({ error: { message: "Unknown parameter: 'response_format'." } }), { status: 400 });
    }
    return OK();
  });
  const progress = [];
  const results = await generateImages({
    preset: presetFor(),
    apiKey: 'sk',
    prompt: 'x',
    parameters: {},
    settings: { enableSmartRetry: true },
    onCompatibilityRetry: retry => progress.push(retry),
  });
  assert.equal(bodies.length, 2, '第一次被拒、第二次去掉字段重发');
  assert.equal('response_format' in bodies[1], false);
  assert.equal(results.length, 1);
  assert.deepEqual(progress[0].adjustedParameters, ['response_format']);
  assert.match(progress[0].message, /重试（1\/1）/);
});

test('智能重试关闭时不增加请求，其他 400 原因也不触发重发', async t => {
  const bodies = captureFetch(t, () =>
    new Response(JSON.stringify({ error: { message: "Unknown parameter: 'response_format'." } }), { status: 400 }));
  await assert.rejects(
    generateImages({ preset: presetFor(), apiKey: 'sk', prompt: 'x', parameters: {}, settings: {} }),
    error => error.code === 'UPSTREAM_HTTP_ERROR' && /response_format/.test(error.message),
  );
  assert.equal(bodies.length, 1);
});

test('智能重试只移除错误明确点名的 size、quality 或 n', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const [parameter, message] of [
    ['size', 'size is an unsupported parameter'],
    ['quality', 'quality must be omitted because it is not supported'],
    ['n', "parameter 'n' is not allowed"],
  ]) {
    const bodies = [];
    const snapshots = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message } }), { status: 422 });
      }
      return OK();
    };
    const extraBody = { size: '512x768', quality: 'high', n: 2 };
    await generateImages({
      preset: presetFor({ responseFormat: '', extraBody }),
      apiKey: 'sk',
      prompt: 'x',
      parameters: {},
      settings: { enableSmartRetry: true },
      onRequestParameters: value => snapshots.push({ ...value }),
    });
    assert.equal(bodies.length, 2, parameter);
    assert.deepEqual(snapshots.at(-1), { size: bodies[1].size ?? null, quality: bodies[1].quality ?? null });
    assert.equal(parameter in bodies[1], false, parameter);
    for (const kept of Object.keys(extraBody).filter(name => name !== parameter)) {
      assert.equal(bodies[1][kept], extraBody[kept], `${parameter} 报错时保留 ${kept}`);
    }
  }
});

test('审核、鉴权、余额和未知业务错误禁止智能重试', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const cases = [
    [401, 'invalid api key'],
    [403, 'permission denied'],
    [500, 'insufficient quota'],
    [400, 'Content was rejected by upstream moderation: unsupported quality'],
    [400, 'some unknown business error'],
  ];
  for (const [status, message] of cases) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message } }), { status });
    };
    await assert.rejects(generateImages({
      preset: presetFor({ extraBody: { quality: 'high' } }),
      apiKey: 'sk', prompt: 'x', parameters: {}, settings: { enableSmartRetry: true },
    }));
    assert.equal(calls, 1, `HTTP ${status}: ${message}`);
  }

  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(generateImages({
    preset: presetFor(), apiKey: 'sk', prompt: 'x', parameters: {}, settings: { enableSmartRetry: true },
    retryDelays: [0, 0, 0],
  }));
  assert.equal(networkCalls, 4);
});

test('兼容重试第二次仍失败时停止，并附带已尝试修正记录', async t => {
  let calls = 0;
  const bodies = captureFetch(t, () => {
    calls += 1;
    return new Response(JSON.stringify({
      error: { message: calls === 1 ? 'size is unsupported' : 'second real failure' },
    }), { status: 400 });
  });
  await assert.rejects(
    generateImages({
      preset: presetFor({ extraBody: { size: '512x768' } }),
      apiKey: 'sk', prompt: 'x', parameters: {}, settings: { enableSmartRetry: true },
    }),
    error => /second real failure/.test(error.message)
      && error.compatibilityRetry?.adjustedParameters?.[0] === 'size',
  );
  assert.equal(bodies.length, 2);
});

test('取消发生在回退前时不发送第二次请求；多图仍按一个任务只重试一次', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'size is unsupported' } }), { status: 400 });
  };
  await assert.rejects(generateImages({
    preset: presetFor({ extraBody: { size: '512x768' } }),
    apiKey: 'sk',
    prompt: 'x',
    parameters: { count: 2 },
    settings: { enableSmartRetry: true },
    signal: controller.signal,
    onCompatibilityRetry: () => controller.abort(new Error('user cancelled')),
  }));
  assert.equal(calls, 1);

  calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if ('size' in body) {
      return new Response(JSON.stringify({ error: { message: 'size is unsupported' } }), { status: 400 });
    }
    return new Response(JSON.stringify({
      data: [{ b64_json: 'AAAA' }, { b64_json: 'BBBB' }],
    }), { status: 200 });
  };
  const results = await generateImages({
    preset: presetFor({ extraBody: { size: '512x768', n: 2 } }),
    apiKey: 'sk', prompt: 'x', parameters: { count: 2 }, settings: { enableSmartRetry: true },
  });
  assert.equal(calls, 2);
  assert.equal(results.length, 2);
});

const serverImages = createRequire(import.meta.url)('../../server-plugin/src/adapters/openai-images.js');
const sampleImage = 'https://example.com/result.png';

for (const [name, adapter] of [
  ['直连', { generate: generateImages, parse: parseImageResponse }],
  ['服务端', { generate: serverImages.generate, parse: serverImages.parseImageResponse }],
]) {
  test(name + '兼容图片字段、链接数组、聊天正文与内嵌数据', () => {
    const samples = [
      { images: [sampleImage] }, { data: { url: sampleImage } }, { data: sampleImage },
      { url: sampleImage }, { image: sampleImage }, [sampleImage], { output: sampleImage },
      { result: { output: [sampleImage] } },
      { choices: [{ message: { images: [{ image_url: { url: sampleImage } }] } }] },
      { choices: [{ message: { content: '画好了：![画](<'+sampleImage+'>) 说明 https://example.com/docs' } }] },
      { choices: [{ message: { content: '画好了：'+sampleImage+'。' } }] },
      { choices: [{ message: { content: [{ type: 'image_url', image_url: { url: sampleImage } }] } }] },
      { message: { images: [sampleImage], content: '![同一张]('+sampleImage+')' } },
      { assets: [{ download_url: sampleImage }] },
    ];
    for (const payload of samples) {
      assert.deepEqual(adapter.parse(payload), [{ sourceType: 'url', value: sampleImage, generationIndex: 0 }], JSON.stringify(payload));
    }
    for (const payload of [
      { base64: PNG_BASE64 }, { image: PNG_BASE64 },
      { url: 'data:image/png;base64,' + PNG_BASE64 },
      { choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + PNG_BASE64 } }] } }] },
    ]) {
      assert.deepEqual(adapter.parse(payload), [{ sourceType: 'base64', value: PNG_BASE64, generationIndex: 0 }]);
    }
    assert.throws(() => adapter.parse({ url: 'file:///tmp/result.png' }), /返回格式|上游响应/);
  });

  test(name + '聊天端点发送 messages，识别 message.images', async t => {
    const fetchBefore = globalThis.fetch;
    t.after(() => { globalThis.fetch = fetchBefore; });
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://example.com/v1/chat/completions');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.messages, [{ role: 'user', content: 'a cat' }]);
      assert.equal(body.stream, false);
      assert.equal(Object.hasOwn(body, 'prompt'), false);
      assert.equal(Object.hasOwn(body, 'response_format'), false);
      return Response.json({ choices: [{ message: { images: [sampleImage] } }] });
    };
    const items = await adapter.generate({
      preset: { baseUrl: 'https://example.com/v1', generationPath: '/v1/chat/completions', selectedModel: 'image', timeoutMs: 1000 },
      apiKey: 'test-key', prompt: 'a cat', parameters: {}, settings: {},
    });
    assert.equal(items[0].value, sampleImage);
  });

  test(name + '收到小票后显示排队，使用同一密钥 GET 原任务，不再次 POST', async t => {
    const fetchBefore = globalThis.fetch;
    t.after(() => { globalThis.fetch = fetchBefore; });
    const calls = [], progress = [];
    globalThis.fetch = async (url, init) => {
      calls.push([url, init.method, init.headers.Authorization]);
      if (init.method === 'POST') return Response.json({ data: { id: 'job-21', execution_mode: 'async', assets: [] } }, { status: 202 });
      assert.deepEqual(progress, ['中转站在后台排队画']);
      return Response.json({ status: 'success', data: { status: 'completed', assets: [{ url: sampleImage }] } });
    };
    const items = await adapter.generate({
      preset: { baseUrl: 'https://example.com/v1', generationPath: '/v1/images/generations', selectedModel: 'image', timeoutMs: 6000 },
      apiKey: 'test-key', prompt: 'a cat', parameters: {}, settings: { enableSmartRetry: true },
      onPolling: message => progress.push(message),
    });
    assert.equal(items[0].value, sampleImage);
    assert.deepEqual(calls, [
      ['https://example.com/v1/images/generations', 'POST', 'Bearer test-key'],
      ['https://example.com/v1/images/generations/job-21', 'GET', 'Bearer test-key'],
    ]);
  });

  test(name + '未知响应保留诊断结构并遮住密钥、签名和图片数据', () => {
    assert.throws(() => adapter.parse({
      mystery: { api_key: 'private-value', note: 'gateway-credential', url: 'https://example.com/?signature=private-signature' },
      extra: { base64: PNG_BASE64 },
    }, 'gateway-credential'), error => {
      assert.equal(error.code, 'UPSTREAM_RESPONSE_INVALID');
      assert.match(error.details, /mystery.*api_key/);
      for (const secret of ['private-value', 'gateway-credential', 'private-signature', PNG_BASE64]) {
        assert.ok(!error.details.includes(secret));
      }
      return true;
    });
  });
}

function taskOptions(overrides = {}) {
  return {
    endpoint: 'https://example.com/v1/images/generations', deadline: Date.now() + 60_000,
    sleep: async () => {},
    makeError: (code, details, status) => new DirectError(code, details, status, false, details),
    ...overrides,
  };
}

test('状态查询采用递增间隔，最长十秒；临时错误只重试 GET', async () => {
  const delays = [];
  let attempts = 0;
  const images = await resolveImageResponse({ task_id: 'task-42', assets: [] }, taskOptions({
    sleep: async delay => delays.push(delay),
    request: async () => {
      attempts++;
      if (attempts === 2) throw new DirectError('UPSTREAM_HTTP_ERROR', 'temporary', 502, true);
      return attempts < 7 ? { status: 'processing', assets: [] } : { status: 'completed', assets: [sampleImage] };
    },
  }));
  assert.equal(images[0].value, sampleImage);
  assert.deepEqual(delays, [2000, 3000, 4500, 6750, 10000, 10000, 10000]);
});

test('异步任务超时或取消时不再发状态查询', async () => {
  const request = async () => assert.fail('没有等待预算或取消后不应请求');
  const payload = { execution_mode: 'async', id: 'task-42', assets: [] };
  await assert.rejects(resolveImageResponse(payload, taskOptions({ deadline: Date.now() - 1, request })), error =>
    error.code === 'UPSTREAM_TIMEOUT' && error.details.includes('task-42') && !error.retryable);
  const controller = new AbortController();
  const reason = new Error('用户取消');
  await assert.rejects(resolveImageResponse(payload, taskOptions({
    signal: controller.signal, request, onPolling: () => controller.abort(reason),
  })), error => error === reason);
});

test('任务失败或完成但无图立即退出，并给出最后一次查询的诊断', async () => {
  for (const [status, code] of [['failed', 'UPSTREAM_HTTP_ERROR'], ['completed', 'UPSTREAM_RESPONSE_INVALID']]) {
    let calls = 0;
    await assert.rejects(resolveImageResponse({ task_id: 'id-1' }, taskOptions({
      request: async () => { calls++; return { status, assets: [], extra: 'final-result' }; },
    })), error => error.code === code && error.details.includes('final-result'));
    assert.equal(calls, 1);
  }
  await assert.rejects(resolveImageResponse({ task_id: '../bad' }, taskOptions({
    request: async () => assert.fail('异常任务 ID 不发请求'),
  })), /有效的任务 ID/);
});

test('同步回图附带任务 ID 时直接接图；异步小票不会把回显链接当成结果', async () => {
  const request = async () => assert.fail('已回图无需轮询');
  const sync = await resolveImageResponse({ task_id: 'id-1', data: [sampleImage] }, taskOptions({ request }));
  assert.equal(sync[0].value, sampleImage);
  let calls = 0;
  const asyncImages = await resolveImageResponse({
    task_id: 'id-2', execution_mode: 'async', assets: [], url: 'https://example.com/input.png',
  }, taskOptions({
    request: async () => { calls++; return { status: 'completed', assets: [sampleImage] }; },
  }));
  assert.equal(calls, 1);
  assert.equal(asyncImages[0].value, sampleImage);
});

test('达到预设超时时取消进行中的 GET 查询', async () => {
  let queries = 0;
  let aborted = false;
  await assert.rejects(resolveImageResponse({ task_id: 'slow-task', assets: [] }, taskOptions({
    deadline: Date.now() + 100,
    request: async (_url, signal) => {
      queries++;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true }));
    },
  })), error => error.code === 'UPSTREAM_TIMEOUT');
  assert.equal(queries, 1);
  assert.equal(aborted, true);
});
