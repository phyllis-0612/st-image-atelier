import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DirectError,
  base64ToBytes,
  bytesToBase64,
  detectImageType,
  fetchJson,
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

test('浏览器 Base64 转换与图片 magic bytes 校验', () => {
  const bytes = base64ToBytes(PNG_BASE64);
  assert.equal(detectImageType(bytes)?.extension, 'png');
  assert.equal(bytesToBase64(bytes), PNG_BASE64);
});
