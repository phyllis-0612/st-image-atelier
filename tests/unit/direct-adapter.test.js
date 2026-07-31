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
    error => error.code === 'DIRECT_FETCH_BLOCKED' && /浏览器无法读取/.test(error.message),
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
      && !/关闭 size/.test(error.message),
  );
});

test('浏览器 Base64 转换与图片 magic bytes 校验', () => {
  const bytes = base64ToBytes(PNG_BASE64);
  assert.equal(detectImageType(bytes)?.extension, 'png');
  assert.equal(bytesToBase64(bytes), PNG_BASE64);
});
