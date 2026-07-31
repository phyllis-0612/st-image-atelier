const ERROR_MESSAGES = {
  PRESET_NOT_CONFIGURED: 'API 预设未配置',
  API_KEY_MISSING: '缺少 API 密钥',
  MODEL_NOT_SELECTED: '未选择模型',
  UPSTREAM_AUTH_FAILED: 'API 鉴权失败，请检查密钥',
  UPSTREAM_RATE_LIMITED: 'API 限流，请稍后重试',
  UPSTREAM_TIMEOUT: '请求超时',
  UPSTREAM_HTTP_ERROR: '上游服务错误',
  UPSTREAM_RESPONSE_INVALID: '返回格式不兼容',
  DIRECT_FETCH_BLOCKED: '浏览器无法读取生图接口或返回图片，请检查地址、网络和 CORS 设置',
  IMAGE_DOWNLOAD_FAILED: '图片下载失败',
  LOCAL_SAVE_FAILED: '图片保存到酒馆失败',
  VALIDATION_FAILED: '请求参数无效',
};

export class DirectError extends Error {
  constructor(code, details = '', status = 400, retryable = false, publicMessage = '') {
    super(publicMessage || ERROR_MESSAGES[code] || '生图请求失败');
    this.name = 'DirectError';
    this.code = code;
    this.details = details;
    this.status = status;
    this.retryable = retryable;
  }
}

export function normalizeEndpoint(baseUrl, endpointPath) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new DirectError('VALIDATION_FAILED', 'Base URL 无效');
  }
  const baseParts = url.pathname.split('/').filter(Boolean);
  const endpointParts = String(endpointPath || '').split('/').filter(Boolean);
  if (baseParts.at(-1)?.toLowerCase() === 'v1' && endpointParts[0]?.toLowerCase() === 'v1') {
    endpointParts.shift();
  }
  url.pathname = `/${[...baseParts, ...endpointParts].join('/')}`;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function validateEndpoint(urlString, allowHttp = false) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new DirectError('VALIDATION_FAILED', '默认只允许 HTTPS；本地服务需明确开启 HTTP');
  }
  if (url.username || url.password) {
    throw new DirectError('VALIDATION_FAILED', 'URL 不得包含用户名或密码');
  }
  return url;
}

function findDataArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.data)) return payload.data;
  for (const key of ['result', 'output', 'response']) {
    const found = findDataArray(payload[key]);
    if (found) return found;
  }
  return null;
}

export function parseImageResponse(payload) {
  const items = findDataArray(payload);
  if (!items?.length) throw new DirectError('UPSTREAM_RESPONSE_INVALID', '响应中没有图片数组');
  const results = items.map((item, generationIndex) => {
    if (!item || typeof item !== 'object') return null;
    if (typeof item.b64_json === 'string' && item.b64_json) {
      return { sourceType: 'base64', value: item.b64_json, generationIndex };
    }
    if (typeof item.url === 'string' && item.url) {
      return { sourceType: 'url', value: item.url, generationIndex };
    }
    return null;
  }).filter(Boolean);
  if (!results.length) throw new DirectError('UPSTREAM_RESPONSE_INVALID', '响应中没有 url 或 b64_json');
  return results;
}

export function parseModelsResponse(payload) {
  const items = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(items)) throw new DirectError('UPSTREAM_RESPONSE_INVALID', '模型列表格式不兼容');
  return items
    .map(item => typeof item === 'string'
      ? { id: item }
      : { id: String(item?.id ?? ''), ...(item?.owned_by ? { ownedBy: item.owned_by } : {}) })
    .filter(item => item.id);
}

export function normalizeImageSize(value) {
  return String(value || '')
    .trim()
    .replace(/(\d)\s*[×✕✖＊*X]\s*(\d)/g, '$1x$2');
}

function sanitizeUpstreamText(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|key)-[A-Za-z0-9._-]{6,}\b/g, '[已隐藏密钥]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function extractUpstreamError(bodyText) {
  let value = bodyText;
  try {
    const payload = JSON.parse(bodyText);
    value = payload?.error?.message
      || payload?.error?.detail
      || payload?.message
      || payload?.detail
      || (typeof payload?.error === 'string' ? payload.error : '')
      || bodyText;
  } catch {
    // Plain-text error bodies are common among OpenAI-compatible gateways.
  }
  return sanitizeUpstreamText(value) || '上游没有返回错误详情';
}

function mapStatus(status, bodyText) {
  const reason = extractUpstreamError(bodyText);
  if (status === 401 || status === 403) {
    return new DirectError(
      'UPSTREAM_AUTH_FAILED',
      reason,
      status,
      false,
      `API 鉴权失败（HTTP ${status}）：${reason}`,
    );
  }
  if (status === 429) {
    return new DirectError(
      'UPSTREAM_RATE_LIMITED',
      reason,
      status,
      true,
      `API 限流（HTTP 429）：${reason}`,
    );
  }
  const moderationRejected = /moderation|content (?:was )?rejected|safety|content policy|内容审核|内容政策/i
    .test(reason);
  const hint = status === 404
    ? '；请检查“生图路径”是否与该 API 一致'
    : moderationRejected
      ? '；提示词被上游内容审核拒绝，请减少强迫、暴力、露骨或高风险内容后重试'
      : status === 400
        ? '；若上游提示参数不支持，可在“高级设置”关闭 size、quality 或 n'
        : '';
  return new DirectError(
    'UPSTREAM_HTTP_ERROR',
    reason,
    status,
    status >= 500,
    `上游生图请求失败（HTTP ${status}）：${reason}${hint}`,
  );
}

export async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const externalSignal = options.signal;
  const abort = () => controller.abort(externalSignal.reason);
  externalSignal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
    const text = await response.text();
    if (!response.ok) throw mapStatus(response.status, text.slice(0, 1000));
    try {
      return JSON.parse(text);
    } catch {
      throw new DirectError('UPSTREAM_RESPONSE_INVALID', '上游返回的不是 JSON');
    }
  } catch (error) {
    if (error instanceof DirectError) throw error;
    if (controller.signal.aborted) {
      throw new DirectError('UPSTREAM_TIMEOUT', '请求已超时或取消', 504, true);
    }
    throw new DirectError('DIRECT_FETCH_BLOCKED', error?.message || 'Failed to fetch', 0, true);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
}

function authorization(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

export async function generateImages({ preset, apiKey, prompt, parameters, settings, signal }) {
  if (!preset.baseUrl) throw new DirectError('PRESET_NOT_CONFIGURED');
  if (!apiKey) throw new DirectError('API_KEY_MISSING');
  if (!preset.selectedModel) throw new DirectError('MODEL_NOT_SELECTED');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20_000) {
    throw new DirectError('VALIDATION_FAILED', '提示词必须为 1-20000 个字符');
  }
  const endpoint = normalizeEndpoint(preset.baseUrl, preset.generationPath);
  validateEndpoint(endpoint, settings.allowHttp);
  const body = { model: preset.selectedModel, prompt: prompt.trim() };
  if (preset.sendSize) body.size = normalizeImageSize(parameters.size || preset.defaultSize);
  if (preset.sendQuality) body.quality = parameters.quality || preset.defaultQuality;
  if (preset.sendN) body.n = parameters.count || preset.defaultCount;
  Object.assign(body, preset.extraBody || {}, parameters.extraBody || {});
  body.model = preset.selectedModel;
  body.prompt = prompt.trim();
  if ('size' in body) body.size = normalizeImageSize(body.size);
  const payload = await fetchJson(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authorization(apiKey) },
    body: JSON.stringify(body),
    signal,
  }, preset.timeoutMs);
  return parseImageResponse(payload);
}

export async function listModelsDirect({ preset, apiKey, settings, signal }) {
  if (!preset.baseUrl) throw new DirectError('PRESET_NOT_CONFIGURED');
  if (!apiKey) throw new DirectError('API_KEY_MISSING');
  const endpoint = normalizeEndpoint(preset.baseUrl, preset.modelsPath);
  validateEndpoint(endpoint, settings.allowHttp);
  const payload = await fetchJson(endpoint, {
    method: 'GET',
    headers: authorization(apiKey),
    signal,
  }, Math.min(preset.timeoutMs, 60_000));
  return parseModelsResponse(payload);
}

export function detectImageType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  const begins = values => values.every((value, index) => bytes[index] === value);
  if (begins([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (begins([0xff, 0xd8, 0xff])) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const size = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += size) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + size));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const clean = String(value).replace(/^data:[^;,]+;base64,/i, '').replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
