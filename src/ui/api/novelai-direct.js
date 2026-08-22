import {
  DirectError,
  bytesToBase64,
  detectImageType,
  extractUpstreamError,
  normalizeEndpoint,
  normalizeImageSize,
  parseImageResponse,
  validateEndpoint,
} from './openai-direct.js';

export const NOVELAI_MODELS = Object.freeze([
  { id: 'nai-diffusion-5-full', label: 'NAI Diffusion V5 Full' },
  { id: 'nai-diffusion-5-curated', label: 'NAI Diffusion V5 Curated' },
  { id: 'nai-diffusion-4-5-full', label: 'NAI Diffusion V4.5 Full' },
  { id: 'nai-diffusion-4-5-curated', label: 'NAI Diffusion V4.5 Curated' },
  { id: 'nai-diffusion-4-full', label: 'NAI Diffusion V4 Full' },
  { id: 'nai-diffusion-4-curated-preview', label: 'NAI Diffusion V4 Curated' },
  { id: 'nai-diffusion-3', label: 'NAI Diffusion V3' },
]);

export const NOVELAI_SAMPLERS = Object.freeze([
  ['k_euler', 'Euler'],
  ['k_euler_ancestral', 'Euler Ancestral'],
  ['k_dpmpp_2s_ancestral', 'DPM++ 2S Ancestral'],
  ['k_dpmpp_2m', 'DPM++ 2M'],
  ['k_dpmpp_2m_sde', 'DPM++ 2M SDE'],
  ['k_dpmpp_sde', 'DPM++ SDE'],
  ['ddim_v3', 'DDIM'],
]);

const QUALITY_TAGS = Object.freeze({
  'nai-diffusion-3': 'best quality, amazing quality, very aesthetic, absurdres',
  'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated-preview': 'rating:general, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': 'very aesthetic, masterpiece, no text, rating:general',
  'nai-diffusion-5-full': 'very aesthetic, amazing quality, no text',
  'nai-diffusion-5-curated': 'very aesthetic, masterpiece, no text',
});

function joinPrompt(...parts) {
  return parts
    .map(value => String(value || '').trim().replace(/^[,\s]+|[,\s]+$/g, ''))
    .filter(Boolean)
    .join(', ');
}

export function normalizeNovelAiEndpoint(baseUrl, generationPath = '/ai/generate-image') {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new DirectError('VALIDATION_FAILED', 'NAI 中转站 / 站点地址无效');
  }
  if (/\/ai\/generate-image\/?$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  }
  const normalizedPath = `/${String(generationPath || '/ai/generate-image')
    .split('/')
    .filter(Boolean)
    .join('/')}`;
  // Some multi-protocol relays expose OpenAI under /api/v1 but keep their
  // NovelAI-native route under /api/ai/generate-image. Aurora is one common
  // example. Accepting the familiar GPT base URL here avoids producing the
  // invalid /api/v1/ai/generate-image route while leaving custom NAI paths
  // untouched.
  if (normalizedPath.toLowerCase() === '/ai/generate-image'
    && /\/api\/v1\/?$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/v1\/?$/i, '');
    url.search = '';
    url.hash = '';
    return normalizeEndpoint(url.toString(), normalizedPath);
  }
  return normalizeEndpoint(baseUrl, normalizedPath);
}

export function composeNovelAiPrompt(prompt, artistPrompt = '', config = {}) {
  const quality = config.qualityTags === false ? '' : QUALITY_TAGS[config.model] || '';
  return joinPrompt(artistPrompt, prompt, quality);
}

function randomSeed() {
  if (globalThis.crypto?.getRandomValues) {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return value[0];
  }
  return Math.floor(Math.random() * 0x1_0000_0000);
}

function parseSize(value) {
  const normalized = normalizeImageSize(value);
  const match = /^(\d{2,4})x(\d{2,4})$/i.exec(normalized);
  if (!match) throw new DirectError('VALIDATION_FAILED', 'NovelAI 尺寸格式应为“宽x高”');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 64 || height < 64 || width > 2048 || height > 2048
    || width % 64 !== 0 || height % 64 !== 0) {
    throw new DirectError('VALIDATION_FAILED', 'NovelAI 宽高需为 64 的倍数，且不超过 2048');
  }
  return { width, height };
}

function finiteNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function varietySigma(model) {
  if (model.includes('4-5')) return 59.04722600415217;
  if (model.includes('4')) return 19;
  return 19;
}

export function buildNovelAiPayload({ config, prompt, artistPrompt, size, count }) {
  if (!config?.model) throw new DirectError('MODEL_NOT_SELECTED');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20_000) {
    throw new DirectError('VALIDATION_FAILED', '提示词必须为 1-20000 个字符');
  }
  const resolvedPrompt = composeNovelAiPrompt(prompt, artistPrompt, config);
  if (resolvedPrompt.length > 20_000) {
    throw new DirectError('VALIDATION_FAILED', '画师串与正文合计不能超过 20000 个字符');
  }
  const negativePrompt = String(config.negativePrompt || '').trim();
  const { width, height } = parseSize(size || config.defaultSize);
  const model = String(config.model);
  const samples = Math.round(finiteNumber(count ?? config.defaultCount, 1, 1, 4));
  const configuredSeed = Number(config.seed);
  const seed = Number.isInteger(configuredSeed) && configuredSeed >= 0
    ? Math.min(configuredSeed, 0xffff_ffff)
    : randomSeed();
  const isV5 = model.includes('nai-diffusion-5');
  const isV4 = model !== 'nai-diffusion-3';
  const parameters = {
    params_version: isV5 ? 4 : 3,
    width,
    height,
    scale: finiteNumber(config.scale, 5, 0, 20),
    sampler: config.sampler || 'k_euler',
    steps: Math.round(finiteNumber(config.steps, 28, 1, 50)),
    n_samples: samples,
    seed,
    negative_prompt: negativePrompt,
    qualityToggle: false,
    ucPreset: 0,
    sm: Boolean(config.smea),
    sm_dyn: Boolean(config.smea && config.smeaDyn),
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    legacy_uc: false,
    legacy_v3_extend: false,
    add_original_image: true,
    cfg_rescale: finiteNumber(config.cfgRescale, 0, 0, 1),
    noise_schedule: config.noiseSchedule || 'karras',
    skip_cfg_above_sigma: config.variety === false ? null : varietySigma(model),
    use_coords: false,
  };
  if (config.sampler === 'k_euler_ancestral') {
    parameters.deliberate_euler_ancestral_bug = false;
    parameters.prefer_brownian = true;
  }
  if (isV4) {
    delete parameters.sm;
    delete parameters.sm_dyn;
    parameters.v4_prompt = {
      caption: { base_caption: resolvedPrompt, char_captions: [] },
      use_coords: false,
      use_order: true,
    };
    parameters.v4_negative_prompt = {
      caption: { base_caption: negativePrompt, char_captions: [] },
      legacy_uc: false,
    };
  }
  if (isV5) {
    parameters.straight_alpha = false;
    parameters.tag_hint_qt = config.qualityTags === false ? 0 : 1;
    parameters.tag_hint_uc_preset = 0;
    parameters.qualityPresetId = config.qualityTags === false ? 'none' : 'standard';
    parameters.ucPresetId = 'none';
    parameters.image_format = 'png';
    delete parameters.qualityToggle;
    delete parameters.ucPreset;
  }
  return {
    resolvedPrompt,
    seed,
    body: {
      input: resolvedPrompt,
      model,
      action: 'generate',
      parameters,
      use_new_shared_trial: true,
    },
  };
}

function findEndOfCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new DirectError('UPSTREAM_RESPONSE_INVALID', '当前浏览器不支持解压 NovelAI 图片包，请升级浏览器');
  }
  let stream;
  try {
    stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  } catch {
    throw new DirectError('UPSTREAM_RESPONSE_INVALID', '当前浏览器不支持 ZIP Deflate 解压');
  }
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzipNovelAiImages(arrayBuffer, maxImageBytes = 30 * 1024 * 1024) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new DirectError('UPSTREAM_RESPONSE_INVALID', 'NovelAI 返回的 ZIP 图片包无效');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const images = [];
  for (let index = 0; index < entries && images.length < 4; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new DirectError('UPSTREAM_RESPONSE_INVALID', 'NovelAI ZIP 目录损坏');
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    offset = nameStart + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new DirectError('UPSTREAM_RESPONSE_INVALID', 'NovelAI 返回了加密 ZIP，无法读取');
    if (uncompressedSize > maxImageBytes) {
      throw new DirectError('IMAGE_DOWNLOAD_FAILED', 'NovelAI 返回的单张图片超过大小限制');
    }
    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new DirectError('UPSTREAM_RESPONSE_INVALID', 'NovelAI ZIP 文件项损坏');
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let imageBytes;
    if (method === 0) imageBytes = new Uint8Array(compressed);
    else if (method === 8) imageBytes = await inflateRaw(compressed);
    else throw new DirectError('UPSTREAM_RESPONSE_INVALID', `不支持 NovelAI ZIP 压缩方式 ${method}`);
    if (imageBytes.byteLength !== uncompressedSize || imageBytes.byteLength > maxImageBytes) {
      throw new DirectError('UPSTREAM_RESPONSE_INVALID', 'NovelAI ZIP 图片长度校验失败');
    }
    images.push(imageBytes);
  }
  if (!images.length) throw new DirectError('UPSTREAM_RESPONSE_INVALID', 'NovelAI ZIP 中没有图片');
  return images;
}

function mapNovelAiError(status, text) {
  const reason = extractUpstreamError(text);
  if (status === 401 || status === 403) {
    return new DirectError(
      'UPSTREAM_AUTH_FAILED', reason, status, false,
      `NAI 中转站 Key / Token 无效或已过期（HTTP ${status}）：${reason}`,
    );
  }
  if (status === 402) {
    return new DirectError(
      'UPSTREAM_AUTH_FAILED', reason, status, false,
      `NAI 中转站余额、套餐或上游订阅不可用（HTTP 402）：${reason}`,
    );
  }
  if (status === 429) {
    return new DirectError(
      'UPSTREAM_RATE_LIMITED', reason, status, true,
      `NovelAI 请求过于频繁（HTTP 429）：${reason}`,
    );
  }
  return new DirectError(
    'UPSTREAM_HTTP_ERROR', reason, status, status >= 500,
    `NovelAI 生图失败（HTTP ${status}）：${reason}`,
  );
}

async function fetchNovelAi(url, options, timeoutMs, maxImageBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const externalSignal = options.signal;
  const abort = () => controller.abort(externalSignal.reason);
  externalSignal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw mapNovelAiError(response.status, (await response.text()).slice(0, 1000));
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxImageBytes * 4) {
      throw new DirectError('IMAGE_DOWNLOAD_FAILED', 'NovelAI 返回的图片包超过大小限制');
    }
    if (contentType.includes('json')) {
      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new DirectError('UPSTREAM_RESPONSE_INVALID', 'NovelAI 兼容站返回的 JSON 无效');
      }
      if (Array.isArray(payload?.images)) {
        if (payload.images.every(value => typeof value === 'string')) {
          return payload.images.map((value, generationIndex) => ({
            sourceType: 'base64',
            value: value.replace(/^data:[^;,]+;base64,/i, ''),
            generationIndex,
          }));
        }
        return parseImageResponse({ data: payload.images });
      }
      return parseImageResponse(payload);
    }
    const imageType = detectImageType(bytes);
    if (imageType || contentType.startsWith('image/')) {
      return [{ sourceType: 'base64', value: bytesToBase64(bytes), generationIndex: 0 }];
    }
    const isZip = bytes.length >= 4
      && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (!isZip) {
      const rawText = new TextDecoder().decode(bytes).trim();
      if (rawText.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(rawText)) {
        return [{ sourceType: 'base64', value: rawText.replace(/\s+/g, ''), generationIndex: 0 }];
      }
    }
    const imageBytes = await unzipNovelAiImages(bytes, maxImageBytes);
    return imageBytes.map((value, generationIndex) => ({
      sourceType: 'base64',
      value: bytesToBase64(value),
      generationIndex,
    }));
  } catch (error) {
    if (error instanceof DirectError) throw error;
    if (controller.signal.aborted) {
      throw new DirectError('UPSTREAM_TIMEOUT', 'NovelAI 请求已超时或取消', 504, true);
    }
    throw new DirectError('DIRECT_FETCH_BLOCKED', error?.message || 'Failed to fetch', 0, true);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
}

export async function generateNovelAiImages({
  config,
  apiKey,
  artistPrompt,
  prompt,
  parameters,
  settings,
  signal,
}) {
  if (!config?.baseUrl) throw new DirectError('PRESET_NOT_CONFIGURED', 'NAI 中转站 / 站点未配置');
  if (!apiKey) throw new DirectError('API_KEY_MISSING', '缺少 NAI 中转站 Key / Token');
  const endpoint = normalizeNovelAiEndpoint(
    config.baseUrl,
    config.generationPath || '/ai/generate-image',
  );
  validateEndpoint(endpoint, settings.allowHttp);
  const built = buildNovelAiPayload({
    config,
    prompt,
    artistPrompt,
    size: parameters.size || config.defaultSize,
    count: parameters.count || config.defaultCount,
  });
  const sources = await fetchNovelAi(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(built.body),
    signal,
  }, config.timeoutMs || 180_000, settings.maxImageBytes || 30 * 1024 * 1024);
  return { sources, resolvedPrompt: built.resolvedPrompt, seed: built.seed };
}
