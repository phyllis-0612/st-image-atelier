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

test('上游点名拒绝 response_format 时自动去掉重发一次', async t => {
  const bodies = captureFetch(t, (body, attempt) => {
    if ('response_format' in body) {
      return new Response(JSON.stringify({ error: { message: "Unknown parameter: 'response_format'." } }), { status: 400 });
    }
    return OK();
  });
  const results = await generateImages({ preset: presetFor(), apiKey: 'sk', prompt: 'x', parameters: {}, settings: {} });
  assert.equal(bodies.length, 2, '第一次被拒、第二次去掉字段重发');
  assert.equal('response_format' in bodies[1], false);
  assert.equal(results.length, 1);
});

test('其他 400 原因不触发重发，原样报错', async t => {
  const bodies = captureFetch(t, () =>
    new Response(JSON.stringify({ error: { message: 'quality 必须是 low 或 medium' } }), { status: 400 }));
  await assert.rejects(
    generateImages({ preset: presetFor(), apiKey: 'sk', prompt: 'x', parameters: {}, settings: {} }),
    error => error.code === 'UPSTREAM_HTTP_ERROR' && /quality/.test(error.message),
  );
  assert.equal(bodies.length, 1);
});
