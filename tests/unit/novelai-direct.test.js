import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  buildNovelAiPayload,
  composeNovelAiPrompt,
  generateNovelAiImages,
  normalizeNovelAiEndpoint,
  unzipNovelAiImages,
} from '../../src/ui/api/novelai-direct.js';
import { PNG_BASE64 } from '../mocks/mock-upstream.js';

function storedZip(name, data, method = 0) {
  const nameBytes = Buffer.from(name);
  const body = Buffer.from(data);
  const compressed = method === 8 ? deflateRawSync(body) : body;
  const local = Buffer.alloc(30 + nameBytes.length + compressed.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  compressed.copy(local, 30 + nameBytes.length);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  nameBytes.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

test('NovelAI 按画师串、正文、质量标签的顺序组装提示词', () => {
  assert.equal(
    composeNovelAiPrompt('1girl, sunset', 'artist:sample', {
      model: 'nai-diffusion-4-5-full',
      qualityTags: true,
    }),
    'artist:sample, 1girl, sunset, very aesthetic, masterpiece, no text',
  );
  assert.equal(
    composeNovelAiPrompt('1girl', '', { model: 'nai-diffusion-4-5-full', qualityTags: false }),
    '1girl',
  );
});

test('NovelAI 站点可填写 Base URL 或完整生图端点', () => {
  assert.equal(
    normalizeNovelAiEndpoint('https://image.novelai.net', '/ai/generate-image'),
    'https://image.novelai.net/ai/generate-image',
  );
  assert.equal(
    normalizeNovelAiEndpoint('https://nai.example/ai/generate-image', '/ai/generate-image'),
    'https://nai.example/ai/generate-image',
  );
  assert.equal(
    normalizeNovelAiEndpoint('https://relay.example/api', '/ai/generate-image'),
    'https://relay.example/api/ai/generate-image',
  );
});

test('Aurora 常见的 /api/v1 地址会自动切换到原生 NAI 路由', () => {
  assert.equal(
    normalizeNovelAiEndpoint('https://relay.example/api/v1', '/ai/generate-image'),
    'https://relay.example/api/ai/generate-image',
  );
  assert.equal(
    normalizeNovelAiEndpoint('https://relay.example/api/v1/', '/ai/generate-image'),
    'https://relay.example/api/ai/generate-image',
  );
  assert.equal(
    normalizeNovelAiEndpoint('https://relay.example/api/v1', '/custom/nai'),
    'https://relay.example/api/v1/custom/nai',
  );
});

test('NovelAI V4.5 请求包含官方提示词结构和可复现种子', () => {
  const generated = buildNovelAiPayload({
    config: {
      model: 'nai-diffusion-4-5-full',
      sampler: 'k_euler',
      noiseSchedule: 'karras',
      defaultSize: '832x1216',
      defaultCount: 1,
      steps: 28,
      scale: 5,
      cfgRescale: 0,
      seed: 1234,
      negativePrompt: 'bad hands',
      qualityTags: true,
      variety: true,
    },
    prompt: '1girl',
    artistPrompt: 'artist:sample',
    size: '512x768',
    count: 2,
  });
  assert.equal(generated.seed, 1234);
  assert.equal(generated.body.input, generated.resolvedPrompt);
  assert.equal(generated.body.model, 'nai-diffusion-4-5-full');
  assert.equal(generated.body.parameters.width, 512);
  assert.equal(generated.body.parameters.height, 768);
  assert.equal(generated.body.parameters.n_samples, 2);
  assert.equal(generated.body.parameters.v4_prompt.caption.base_caption, generated.resolvedPrompt);
  assert.equal(generated.body.parameters.v4_negative_prompt.caption.base_caption, 'bad hands');
  assert.equal(generated.body.parameters.skip_cfg_above_sigma, 59.04722600415217);
  assert.equal('sm' in generated.body.parameters, false);
  assert.equal('sm_dyn' in generated.body.parameters, false);
});

test('NovelAI ZIP 图片包可解出原始图片字节', async () => {
  const png = Buffer.from(PNG_BASE64, 'base64');
  const zip = storedZip('image_0.png', png);
  const images = await unzipNovelAiImages(zip);
  assert.equal(images.length, 1);
  assert.deepEqual(Buffer.from(images[0]), png);
});

test('NovelAI Deflate ZIP 图片包可在浏览器流中解压', async () => {
  const png = Buffer.from(PNG_BASE64, 'base64');
  const zip = storedZip('image_0.png', png, 8);
  const images = await unzipNovelAiImages(zip);
  assert.deepEqual(Buffer.from(images[0]), png);
});

test('NAI 中转站使用 Bearer Key、原生请求体并解析 ZIP 响应', async t => {
  const originalFetch = globalThis.fetch;
  const png = Buffer.from(PNG_BASE64, 'base64');
  const zip = storedZip('image_0.png', png);
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(zip, {
      status: 200,
      headers: { 'Content-Type': 'application/zip' },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await generateNovelAiImages({
    config: {
      baseUrl: 'https://nai-relay.example',
      generationPath: '/ai/generate-image',
      model: 'nai-diffusion-4-5-full',
      sampler: 'k_euler',
      noiseSchedule: 'karras',
      defaultSize: '512x768',
      defaultCount: 1,
      steps: 28,
      scale: 5,
      cfgRescale: 0,
      seed: 7,
      negativePrompt: '',
      qualityTags: true,
      variety: true,
      timeoutMs: 1000,
    },
    apiKey: 'relay-secret-key',
    artistPrompt: 'artist:sample',
    prompt: '1girl',
    parameters: { size: '512x768', count: 1 },
    settings: { allowHttp: false, maxImageBytes: 1024 * 1024 },
  });
  assert.equal(request.url, 'https://nai-relay.example/ai/generate-image');
  assert.equal(request.options.headers.Authorization, 'Bearer relay-secret-key');
  assert.equal(request.body.action, 'generate');
  assert.equal(request.body.model, 'nai-diffusion-4-5-full');
  assert.equal(request.body.parameters.width, 512);
  assert.equal(request.body.parameters.height, 768);
  assert.match(request.body.input, /^artist:sample, 1girl/);
  assert.equal(result.sources[0].value, PNG_BASE64);
  assert.equal(result.seed, 7);
});
