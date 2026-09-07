import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const adapter = require('../../server-plugin/src/adapters/openai-images');
const { maskKey } = require('../../server-plugin/src/services/preset');
const { assertInside, detectImageType } = require('../../server-plugin/src/utils/validation');
const { atomicWriteJson, readJson } = require('../../server-plugin/src/utils/atomic-json');

test('URL join 不重复 /v1', () => {
  assert.equal(
    adapter.normalizeEndpoint('https://api.example.com', '/v1/images/generations'),
    'https://api.example.com/v1/images/generations',
  );
  assert.equal(
    adapter.normalizeEndpoint('https://api.example.com/v1', '/v1/images/generations'),
    'https://api.example.com/v1/images/generations',
  );
  assert.equal(
    adapter.normalizeEndpoint('https://api.example.com/v1/', '/images/generations'),
    'https://api.example.com/v1/images/generations',
  );
  assert.equal(adapter.normalizeImageSize('1024×1536'), '1024x1536');
});

test('响应解析优先 Base64，并支持包裹层', () => {
  const result = adapter.parseImageResponse({
    result: { data: [{ url: 'https://x', b64_json: 'AAAA' }, { url: 'https://y' }] },
  });
  assert.equal(result[0].sourceType, 'base64');
  assert.equal(result[1].sourceType, 'url');
});

test('模型响应支持 data 与直接数组', () => {
  assert.deepEqual(adapter.parseModelsResponse({ data: [{ id: 'a', owned_by: 'x' }] }), [{ id: 'a', ownedBy: 'x' }]);
  assert.deepEqual(adapter.parseModelsResponse(['a']), [{ id: 'a' }]);
});

test('API Key 掩码不暴露完整值', () => {
  const masked = maskKey('sk-super-secret-abcd');
  assert.equal(masked, 'sk-••••abcd');
  assert.equal(masked.includes('super-secret'), false);
});

test('路径越界被阻止，PNG magic bytes 可识别', () => {
  const root = path.resolve('safe-root');
  assert.throws(
    () => assertInside(root, path.resolve(root, '..', 'outside')),
    error => error.code === 'VALIDATION_FAILED' && error.details === '文件路径越界',
  );
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.deepEqual(detectImageType(png), { mimeType: 'image/png', extension: 'png' });
});

test('JSON 原子写入并保留上一版备份', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stia-atomic-'));
  const file = path.join(directory, 'index.json');
  const backup = path.join(directory, 'index.backup.json');
  await atomicWriteJson(file, { version: 1 }, { backupFile: backup });
  await atomicWriteJson(file, { version: 2 }, { backupFile: backup });
  assert.deepEqual(await readJson(file, {}), { version: 2 });
  assert.deepEqual(await readJson(backup, {}), { version: 1 });
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
});
