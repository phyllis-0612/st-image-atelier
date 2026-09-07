import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DirectError,
  base64ToBytes,
  bytesToBase64,
  detectImageType,
  extractUpstreamError,
  fetchJson,
  generateImages,
  normalizeImageSize,
  normalizeEndpoint,
  parseImageResponse,
  parseModelsResponse,
} from '../../src/ui/api/openai-direct.js';
import { PNG_BASE64 } from '../mocks/mock-upstream.js';

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
    });
    assert.equal(bodies.length, 2, parameter);
    assert.equal(parameter in bodies[1], false, parameter);
    for (const kept of Object.keys(extraBody).filter(name => name !== parameter)) {
      assert.equal(bodies[1][kept], extraBody[kept], `${parameter} 报错时保留 ${kept}`);
    }
  }
});

test('审核、鉴权、限流、网络、5xx 和未知错误禁止智能重试', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const cases = [
    [401, 'invalid api key'],
    [403, 'permission denied'],
    [429, 'rate limited'],
    [500, 'internal error: unsupported quality'],
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
  }));
  assert.equal(networkCalls, 1);
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
