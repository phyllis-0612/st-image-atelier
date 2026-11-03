'use strict';

const { startGenerationTimeout } = require('../utils/generation-timeout');
const { runGenerationWithRetry } = require('../utils/generation-retry');

const { AppError } = require('../utils/errors');
const { imageSources, imageDownloadAuthorization, preferFluxPortAsync, responseDiagnostic, resolveImageResponse } = require('../utils/openai-image-response');

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

function imageError(code, details, status) {
  return new AppError(code, details, status);
}

function parseImageResponse(payload, apiKey = '') {
  const results = imageSources(payload);
  if (!results.length) throw imageError('UPSTREAM_RESPONSE_INVALID', `响应中没有可识别的图片；上游响应：${responseDiagnostic(payload, apiKey)}`);
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

async function fetchJson(url, options, timeoutMs, wait = {}) {
  const controller = new AbortController();
  const clearDeadline = startGenerationTimeout({ controller, timeoutMs, ...wait });
  const externalSignal = options.signal;
  const abort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
    const text = await response.text();
    if (!response.ok) {
      const key = options.headers?.Authorization?.slice(7);
      const safeText = key ? text.split(key).join('[已隐藏密钥]') : text;
      throw mapStatus(response.status, safeText.slice(0, 1000));
    }
    try {
      return JSON.parse(text);
    } catch {
      throw imageError('UPSTREAM_RESPONSE_INVALID', `上游返回的不是 JSON；上游响应：${responseDiagnostic(text, options.headers?.Authorization?.slice(7))}`);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (controller.signal.aborted) {
      throw new AppError('UPSTREAM_TIMEOUT', '请求已超时或取消', 504, true);
    }
    throw new AppError('UPSTREAM_HTTP_ERROR', error.message, 502, true);
  } finally {
    clearDeadline();
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

async function generate({ preset, apiKey, prompt, parameters, settings, signal, onCompatibilityRetry, onRetry, retryDelays, onTimeout, onPolling, onRequestParameters }) {
  if (!preset.baseUrl) throw new AppError('PRESET_NOT_CONFIGURED');
  if (!apiKey) throw new AppError('API_KEY_MISSING');
  if (!preset.selectedModel) throw new AppError('MODEL_NOT_SELECTED');
  const endpoint = normalizeEndpoint(preset.baseUrl, preset.generationPath);
  validateEndpoint(endpoint, settings.allowHttp);
  const body = { model: preset.selectedModel, prompt };
  if (preset.sendSize) body.size = normalizeImageSize(parameters.size || preset.defaultSize);
  if (preset.sendQuality) body.quality = parameters.quality || preset.defaultQuality;
  if (preset.sendN) body.n = parameters.count || preset.defaultCount;
  const chatEndpoint = /\/chat\/completions$/i.test(new URL(endpoint).pathname);
  const responseFormat = preset.responseFormat === undefined ? 'b64_json' : String(preset.responseFormat || '');
  if (!chatEndpoint && ['b64_json', 'url'].includes(responseFormat)) body.response_format = responseFormat;
  Object.assign(body, preset.extraBody || {}, parameters.extraBody || {});
  body.model = preset.selectedModel;
  body.prompt = prompt;
  if ('size' in body) body.size = normalizeImageSize(body.size);
  if (chatEndpoint) {
    body.messages = [{ role: 'user', content: body.prompt }];
    body.stream = false;
    delete body.prompt;
  }
  const fluxPortAsync = preferFluxPortAsync(endpoint, body);
  let submittedAt;


  const request = payloadBody => {
    submittedAt = Date.now();
    onRequestParameters?.({ size: payloadBody.size ?? null, quality: payloadBody.quality ?? null });
    return fetchJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authorization(apiKey) },
      body: JSON.stringify(payloadBody),
      signal,
    }, preset.timeoutMs, { keepWaiting: settings?.keepWaitingOnTimeout !== false, onTimeout });
  };
  let compatibilityRetry;
  try {
    const payload = await runGenerationWithRetry({
      request: () => request(body),
      enabled: !fluxPortAsync && settings?.enableSmartRetry === true,
      signal, onRetry, retryDelays,
      recover: async error => {
        if (compatibilityRetry) return null;
        const retry = detectCompatibilityRetry(error, body);
        if (!retry) return null;
        compatibilityRetry = retry;
        for (const parameter of retry.adjustedParameters) delete body[parameter];
        await onCompatibilityRetry?.(retry);
        return retry;
      },
    });
    const sources = await resolveImageResponse(payload, {
      endpoint, apiKey, signal, onPolling,
      deadline: submittedAt + (Number(preset.timeoutMs) || 180_000),
      makeError: imageError,
      request: (url, pollSignal) => fetchJson(url, {
        method: 'GET', headers: authorization(apiKey), signal: pollSignal,
      }, 0),
    });
    return sources.map(({ assetTaskId, ...source }) => {
      const authorization = imageDownloadAuthorization({ ...source, assetTaskId }, endpoint, apiKey);
      return authorization ? { ...source, authorization } : source;
    });
  } catch (error) {
    if (compatibilityRetry) error.compatibilityRetry = compatibilityRetry;
    throw error;
  }
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
