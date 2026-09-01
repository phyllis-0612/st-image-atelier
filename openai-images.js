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
  return new AppError('UPSTREAM_HTTP_ERROR', `HTTP ${status}: ${bodyText}`, 502, status >= 500);
}

async function fetchJson(url, options, timeoutMs) {
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

async function generate({ preset, apiKey, prompt, parameters, settings, signal }) {
  if (!preset.baseUrl) throw new AppError('PRESET_NOT_CONFIGURED');
  if (!apiKey) throw new AppError('API_KEY_MISSING');
  if (!preset.selectedModel) throw new AppError('MODEL_NOT_SELECTED');
  const endpoint = normalizeEndpoint(preset.baseUrl, preset.generationPath);
  validateEndpoint(endpoint, settings.allowHttp);
  const body = { model: preset.selectedModel, prompt };
  if (preset.sendSize) body.size = normalizeImageSize(parameters.size || preset.defaultSize);
  if (preset.sendQuality) body.quality = parameters.quality || preset.defaultQuality;
  if (preset.sendN) body.n = parameters.count || preset.defaultCount;
  Object.assign(body, preset.extraBody || {}, parameters.extraBody || {});
  body.model = preset.selectedModel;
  body.prompt = prompt;
  if ('size' in body) body.size = normalizeImageSize(body.size);

  const payload = await fetchJson(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authorization(apiKey) },
    body: JSON.stringify(body),
    signal,
  }, preset.timeoutMs);
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
  generate,
  listModels,
};
