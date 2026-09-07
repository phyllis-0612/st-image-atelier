'use strict';

const { AppError } = require('../utils/errors');

function normalizeEndpoint(baseUrl, endpointPath) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Base URL 无效');
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

function validateEndpoint(urlString, allowHttp = false) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new AppError('VALIDATION_FAILED', '默认只允许 HTTPS；本地服务需明确开启 HTTP');
  }
  if (url.username || url.password) {
    throw new AppError('VALIDATION_FAILED', 'URL 不得包含用户名或密码');
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

function parseImageResponse(payload) {
  const items = findDataArray(payload);
  if (!items?.length) {
    throw new AppError('UPSTREAM_RESPONSE_INVALID', '响应中没有图片数组');
  }
  const results = items.map((item, index) => {
    if (!item || typeof item !== 'object') return null;
    if (typeof item.b64_json === 'string' && item.b64_json) {
      return { sourceType: 'base64', value: item.b64_json, generationIndex: index };
    }
    if (typeof item.url === 'string' && item.url) {
      return { sourceType: 'url', value: item.url, generationIndex: index };
    }
    return null;
  }).filter(Boolean);
  if (!results.length) {
    throw new AppError('UPSTREAM_RESPONSE_INVALID', '响应中没有 url 或 b64_json');
  }
  return results;
}

function parseModelsResponse(payload) {
  const items = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(items)) {
    throw new AppError('UPSTREAM_RESPONSE_INVALID', '模型列表格式不兼容');
  }
  return items
    .map(item => typeof item === 'string'
      ? { id: item }
      : { id: String(item?.id ?? ''), ...(item?.owned_by ? { ownedBy: item.owned_by } : {}) })
    .filter(item => item.id);
}

function mapStatus(status, bodyText) {
  if (status === 401 || status === 403) {
    return new AppError('UPSTREAM_AUTH_FAILED', bodyText, status);
  }
  if (status === 429) {
    return new AppError('UPSTREAM_RATE_LIMITED', bodyText, status, true);
  }
  const error = new AppError('UPSTREAM_HTTP_ERROR', `HTTP ${status}: ${bodyText}`, 502, status >= 500);
  error.upstreamStatus = status;
  return error;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const externalSignal = options.signal;
  const abort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
    const text = await response.text();
    if (!response.ok) throw mapStatus(response.status, text.slice(0, 1000));
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError('UPSTREAM_RESPONSE_INVALID', '上游返回的不是 JSON');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (controller.signal.aborted) {
      throw new AppError('UPSTREAM_TIMEOUT', '请求已超时或取消', 504, true);
    }
    throw new AppError('UPSTREAM_HTTP_ERROR', error.message, 502, true);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
}

function authorization(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

function normalizeImageSize(value) {
  return String(value || '')
    .trim()
    .replace(/(\d)\s*[×✕✖＊*X]\s*(\d)/g, '$1x$2');
}

const SMART_RETRY_PARAMETERS = Object.freeze([
  ['response_format', /response[_ -]?format/i],
  ['size', /\bsize\b|尺寸/i],
  ['quality', /\bquality\b|质量/i],
  ['n', /(?:parameter|param|field|参数)\s*['"`]?n(?:['"`]|\b)|\bn_samples\b|number of images|张数/i],
]);
const PARAMETER_INCOMPATIBLE = /unsupported|not support|unknown (?:parameter|field)|unrecognized|invalid|unexpected|not allowed|must be|expected|不支持|未知参数|无效|非法|不兼容|不允许/i;
const NEVER_RETRY_REASON = /moderation|content (?:was )?rejected|safety|content policy|内容审核|安全策略|余额|quota|配额/i;

function detectCompatibilityRetry(error, body = {}) {
  if (!(error instanceof AppError)
    || error.code !== 'UPSTREAM_HTTP_ERROR'
    || ![400, 422].includes(error.upstreamStatus)) return null;
  const details = String(error.details || '');
  if (!PARAMETER_INCOMPATIBLE.test(details) || NEVER_RETRY_REASON.test(details)) return null;
  const adjustedParameters = SMART_RETRY_PARAMETERS
    .filter(([name, pattern]) => Object.hasOwn(body, name) && pattern.test(details))
    .map(([name]) => name);
  if (!adjustedParameters.length) return null;
  return {
    attempted: true,
    adjustedParameters,
    reason: `${adjustedParameters.join('、')} 参数不兼容`,
    message: `检测到 ${adjustedParameters.join('、')} 参数不兼容，正在回退并重试（1/1）`,
  };
}

async function generate({ preset, apiKey, prompt, parameters, settings, signal, onCompatibilityRetry }) {
  if (!preset.baseUrl) throw new AppError('PRESET_NOT_CONFIGURED');
  if (!apiKey) throw new AppError('API_KEY_MISSING');
  if (!preset.selectedModel) throw new AppError('MODEL_NOT_SELECTED');
  const endpoint = normalizeEndpoint(preset.baseUrl, preset.generationPath);
  validateEndpoint(endpoint, settings.allowHttp);
  const body = { model: preset.selectedModel, prompt };
  if (preset.sendSize) body.size = normalizeImageSize(parameters.size || preset.defaultSize);
  if (preset.sendQuality) body.quality = parameters.quality || preset.defaultQuality;
  if (preset.sendN) body.n = parameters.count || preset.defaultCount;
  const responseFormat = preset.responseFormat === undefined ? 'b64_json' : String(preset.responseFormat || '');
  if (['b64_json', 'url'].includes(responseFormat)) body.response_format = responseFormat;
  Object.assign(body, preset.extraBody || {}, parameters.extraBody || {});
  body.model = preset.selectedModel;
  body.prompt = prompt;
  if ('size' in body) body.size = normalizeImageSize(body.size);

  const request = payloadBody => fetchJson(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authorization(apiKey) },
    body: JSON.stringify(payloadBody),
    signal,
  }, preset.timeoutMs);
  let payload;
  try {
    payload = await request(body);
  } catch (error) {
    const retry = settings?.enableSmartRetry ? detectCompatibilityRetry(error, body) : null;
    if (!retry || signal?.aborted) throw error;
    const fallbackBody = { ...body };
    for (const parameter of retry.adjustedParameters) delete fallbackBody[parameter];
    console.info('[Image Atelier] 智能兼容重试', retry.reason);
    await onCompatibilityRetry?.(retry);
    if (signal?.aborted) throw signal.reason || new AppError('ATTEMPT_INTERRUPTED', '用户已取消');
    try {
      payload = await request(fallbackBody);
    } catch (retryError) {
      retryError.compatibilityRetry = retry;
      throw retryError;
    }
  }
  return parseImageResponse(payload);
}

async function listModels({ preset, apiKey, settings, signal }) {
  if (!preset.baseUrl) throw new AppError('PRESET_NOT_CONFIGURED');
  if (!apiKey) throw new AppError('API_KEY_MISSING');
  const endpoint = normalizeEndpoint(preset.baseUrl, preset.modelsPath);
  validateEndpoint(endpoint, settings.allowHttp);
  const payload = await fetchJson(endpoint, {
    method: 'GET',
    headers: authorization(apiKey),
    signal,
  }, Math.min(preset.timeoutMs, 60_000));
  return parseModelsResponse(payload);
}

module.exports = {
  normalizeEndpoint,
  normalizeImageSize,
  validateEndpoint,
  parseImageResponse,
  parseModelsResponse,
  detectCompatibilityRetry,
  generate,
  listModels,
};
