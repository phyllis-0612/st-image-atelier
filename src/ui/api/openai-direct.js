import {
  imageSources, prepareImageDownloads, preferFluxPortAsync, responseDiagnostic, resolveImageResponse,
  stopNotice, stopNoticeMessage,
} from '../../shared/openai-image-response.js';
import { startGenerationTimeout } from '../../shared/generation-timeout.js';
import { runGenerationWithRetry, waitForRetry } from '../../shared/generation-retry.js';

const ERROR_MESSAGES = {
  PRESET_NOT_CONFIGURED: 'API 预设未配置',
  API_KEY_MISSING: '缺少 API 密钥',
  MODEL_NOT_SELECTED: '未选择模型',
  UPSTREAM_AUTH_FAILED: 'API 鉴权失败，请检查密钥',
  UPSTREAM_RATE_LIMITED: 'API 限流，请稍后重试',
  UPSTREAM_TIMEOUT: '请求超时',
  UPSTREAM_HTTP_ERROR: '上游服务错误',
  UPSTREAM_RESPONSE_INVALID: '返回格式不兼容',
  DIRECT_FETCH_BLOCKED: '浏览器连不上生图接口（网络层失败，没有收到任何响应），请检查地址、网络和中转站的 CORS 设置',
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

function imageError(code, details, status) {
  return new DirectError(code, details, status, false, details);
}

export function parseImageResponse(payload, apiKey = '') {
  const results = imageSources(payload);
  if (!results.length) throw imageError('UPSTREAM_RESPONSE_INVALID', `响应中没有可识别的图片；上游响应：${responseDiagnostic(payload, apiKey)}`);
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
  let halted = null;
  try { halted = stopNotice(JSON.parse(bodyText)); } catch { /* Not JSON. */ }
  if (halted) {
    const message = `${stopNoticeMessage(halted)}（HTTP ${status}）`;
    return new DirectError('UPSTREAM_HTTP_ERROR', message, status, false, message);
  }
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
        ? '；若上游提示参数不支持，可把「默认尺寸 / 默认质量 / 默认数量」改成「不发送」'
        : '';
  return new DirectError(
    'UPSTREAM_HTTP_ERROR',
    reason,
    status,
    status >= 500,
    `上游生图请求失败（HTTP ${status}）：${reason}${hint}`,
  );
}

// Reads a JSON response as it arrives. `onReceive` reports progress, and a complete JSON document is
// returned at once: some gateways keep the connection open after the last byte, and `response.text()`
// would then wait for an end of stream that never comes. Strings and brackets are tracked across
// chunks so a multi-megabyte Base64 body is neither re-scanned nor re-parsed.
async function readJsonBody(response, onReceive, sink = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  const stringSpecial = /["\\]/g;
  let depth = 0;
  let started = false;
  let inString = false;
  let escaped = false;
  let bytes = 0;
  let finished = false;
  let dataAt = 0; // When the JSON document itself began; keep-alive padding before it is still waiting.
  try {
    for (;;) {
      const { value, done } = await reader.read();
      bytes += value?.byteLength || 0;
      const chunk = decoder.decode(value, { stream: !done });
      chunks.push(chunk);
      if ((sink.head?.length || 0) < 8192) sink.head = ((sink.head || '') + chunk).slice(0, 8192);
      for (let index = 0; index < chunk.length; index++) {
        const char = chunk[index];
        if (inString) {
          if (escaped) { escaped = false; continue; }
          stringSpecial.lastIndex = index;
          const match = stringSpecial.exec(chunk);
          if (!match) break;
          index = match.index;
          if (match[0] === '\\') escaped = true;
          else inString = false;
          continue;
        }
        if (!started) {
          if (char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\uFEFF') continue;
          if (char !== '{' && char !== '[') throw Object.assign(new SyntaxError('not json'), { text: chunks.join('').slice(0, 6000) });
          started = true;
          dataAt = Date.now();
        }
        if (char === '"') inString = true;
        else if (char === '{' || char === '[') depth++;
        else if ((char === '}' || char === ']') && --depth === 0) {
          finished = true;
          // JSON.parse also rejects unexpected content after the document in this chunk.
          return { payload: JSON.parse(chunks.join('')), bytes, dataAt };
        }
      }
      if (done) throw Object.assign(new SyntaxError('incomplete json'), { text: chunks.join('').slice(0, 6000) });
      onReceive?.(bytes, dataAt);
    }
  } finally {
    // A stalled connection must not hold up the result while cancellation settles.
    if (!finished) onReceive?.(bytes, dataAt);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* Already released. */ }
  }
}

export async function fetchJson(url, options, timeoutMs, wait = {}) {
  const controller = new AbortController();
  const clearDeadline = startGenerationTimeout({ controller, timeoutMs, ...wait });
  const externalSignal = options.signal;
  const abort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  const key = options.headers?.Authorization?.slice(7);
  const startedAt = Date.now();
  let headersAt = 0;
  let receivedBytes = 0;
  let dataStartedAt = 0;
  let stalled = false;
  let watchdog;
  const sink = {};
  const samples = []; // [time, bytes] for the recent transfer speed
  const speed = () => {
    const now = Date.now();
    while (samples.length > 2 && now - samples[1][0] >= 10_000) samples.shift();
    const [since, base] = samples[0] || [now, receivedBytes];
    return now - since >= 1000 ? Math.round((receivedBytes - base) * 1000 / (now - since)) : null;
  };
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
    if (response.ok && wait.streamBody && response.body?.getReader) {
      headersAt = Date.now();
      const report = (bytes, dataAt) => {
        receivedBytes = bytes;
        if (dataAt && !dataStartedAt) samples.length = 0;
        dataStartedAt = dataAt;
        samples.push([Date.now(), bytes]);
        wait.onReceive?.({
          bytes, receiving: dataAt > 0, speed: dataAt ? speed() : null,
          waitMs: (dataAt || Date.now()) - startedAt, receiveMs: dataAt ? Date.now() - dataAt : 0,
        });
      };
      report(0, 0);
      if (wait.stallMs > 0) {
        // Once the document has started, a transfer that all but stops will not finish: give up on
        // this connection so the caller can read the task again instead of waiting forever.
        let windowAt = 0;
        let windowBytes = 0;
        watchdog = setInterval(() => {
          if (!dataStartedAt) return;
          const now = Date.now();
          if (now - dataStartedAt >= (wait.maxReceiveMs ?? 30 * 60_000)) {
            controller.abort(new Error('receive-limit'));
            return;
          }
          if (!windowAt) { windowAt = dataStartedAt; windowBytes = 0; }
          if (now - windowAt < wait.stallMs) return;
          if (receivedBytes - windowBytes < (wait.stallBytes ?? 32_768)) {
            stalled = true;
            controller.abort(new Error('stalled'));
          } else { windowAt = now; windowBytes = receivedBytes; }
        }, Math.min(1000, Math.max(10, wait.stallMs / 4)));
      }
      let body;
      try {
        body = await readJsonBody(response, report, sink);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw imageError('UPSTREAM_RESPONSE_INVALID', `上游返回的不是完整的 JSON；上游响应：${responseDiagnostic(error.text || '', key)}`);
      }
      wait.onTiming?.({ headersMs: body.dataAt - startedAt, receiveMs: Date.now() - body.dataAt, bytes: body.bytes });
      return body.payload;
    }
    const text = await response.text();
    if (!response.ok) {
      const safeText = key ? text.split(key).join('[已隐藏密钥]') : text;
      throw mapStatus(response.status, safeText);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw imageError('UPSTREAM_RESPONSE_INVALID', `上游返回的不是 JSON；上游响应：${responseDiagnostic(text, key)}`);
    }
  } catch (error) {
    if (error instanceof DirectError) throw error;
    if (stalled && !externalSignal?.aborted) {
      const seconds = Math.round((Date.now() - dataStartedAt) / 1000);
      const message = `图片数据传输停滞（${seconds} 秒只收到 ${(receivedBytes / 1048576).toFixed(1)} MB）。`
        + '回包未能继续传输，暂时无法确定原因；请核对中转站原任务，画笺不会重新生图';
      // Reading a task again is safe; the generation POST itself is never sent twice.
      throw Object.assign(new DirectError('DIRECT_FETCH_BLOCKED', message, 0, !wait.neverResend, message),
        { stalled: true, receivedBytes, head: sink.head || '' });
    }
    if (headersAt && wait.neverResend && !externalSignal?.aborted) {
      // The gateway accepted the job and started answering. Sending the POST again would draw (and
      // bill) a second image, so this is never retryable.
      const megabytes = (receivedBytes / 1048576).toFixed(1);
      const seconds = Math.round((Date.now() - (dataStartedAt || headersAt)) / 1000);
      const message = (dataStartedAt
        ? `中转站已应答，但图片数据没有收完（${seconds} 秒收到 ${megabytes} MB 后中断）。`
        : `中转站已接单，但连接在等待出图 ${seconds} 秒后中断，没有收到图片数据。`)
        + '当前无法确认生成结果，请先到中转站后台查看，不要急着重绘';
      throw new DirectError(controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'DIRECT_FETCH_BLOCKED',
        message, controller.signal.aborted ? 504 : 0, false, message);
    }
    if (controller.signal.aborted) {
      throw new DirectError('UPSTREAM_TIMEOUT', '请求已超时或取消', 504, true);
    }
    throw new DirectError('DIRECT_FETCH_BLOCKED', error?.message || 'Failed to fetch', 0, true);
  } finally {
    clearInterval(watchdog);
    clearDeadline();
    externalSignal?.removeEventListener('abort', abort);
  }
}

export function isFluxPortPreset(preset) {
  try {
    const url = new URL(preset?.baseUrl);
    return url.protocol === 'https:' && !url.username && !url.password
      && ['api.ai-media.vip', 'api.uselg.top'].includes(url.host);
  } catch { return false; }
}

const TASK_ID = /^imgtask_[a-z0-9_-]{1,120}$/i;

// The task is expected to be finished already: ask at once, and only pace the queries after that.
function promptPolling() {
  let asked = false;
  return (ms, signal) => {
    if (asked) return waitForRetry(ms, signal);
    asked = true;
    return Promise.resolve();
  };
}
const STALL_LIMIT = 3;

// Shared by generation and recovery: streamed reads with progress, timing, and stall handling.
// A stalled or interrupted read is repeated on a new connection up to STALL_LIMIT times in total;
// it only ever reads the original task and never submits a new generation.
function taskReader({ apiKey, onReceive, stallMs }) {
  const timing = { waitMs: 0, receiveMs: 0, receiveBytes: 0 };
  let stalls = 0;
  const track = (phase, touch) => {
    let reported = 0;
    return {
      streamBody: true,
      ...(stallMs > 0 ? { stallMs } : {}),
      onReceive: progress => {
        // Tell the resolver the picture is still arriving, so a slow but moving download is not cut off.
        if (progress.receiving && progress.bytes - reported >= 262_144) { reported = progress.bytes; touch?.(); }
        onReceive?.({ ...progress, phase, connection: stalls + 1 });
      },
      onTiming: ({ receiveMs, bytes }) => {
        // Small status answers are part of waiting for the gateway; only image-sized bodies count as receiving.
        if (bytes < 65_536) return;
        timing.receiveMs += receiveMs;
        timing.receiveBytes += bytes;
      },
    };
  };
  function noteStall(error) {
    if (!error?.stalled) return error;
    stalls += 1;
    if (stalls < STALL_LIMIT) return error;
    const message = `连续 ${STALL_LIMIT} 次连接都在传输中停滞（最后一次只收到 ${(error.receivedBytes / 1048576).toFixed(1)} MB）。`
      + '画笺已停止，不会重新生图；请核对中转站原任务。'
      + '可换 API 域名或开代理后点「找回流港图片」，或从后台下载原图后点「导入原图」';
    return Object.assign(new DirectError('DIRECT_FETCH_BLOCKED', message, 0, false, message), { stalled: true });
  }
  const query = async (url, signal, { result = false, touch } = {}) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchJson(url, {
          method: 'GET', headers: authorization(apiKey), signal, credentials: 'omit',
        }, 0, track(result ? 'result' : 'poll', touch));
      } catch (caught) {
        const error = noteStall(caught);
        if (!result || signal?.aborted || attempt >= 2 || !error.retryable
          || !['DIRECT_FETCH_BLOCKED', 'UPSTREAM_TIMEOUT'].includes(error.code)) throw error;
      }
    }
  };
  return { timing, track, query, noteStall };
}

// Reads one finished FluxPort task again by ID. Read-only: nothing is generated or billed.
export async function recoverFluxPortImages({
  preset, apiKey, taskId, signal, onPolling, onReceive, onTiming, stallMs = 45_000, sleep,
}) {
  const fail = (code, message, status) => new DirectError(code, message, status, false, message);
  if (!isFluxPortPreset(preset)) throw fail('VALIDATION_FAILED', '请切换到生成这张图时使用的流港预设');
  if (!TASK_ID.test(taskId || '')) throw fail('VALIDATION_FAILED', '请输入完整的流港图片任务 ID（imgtask_ 开头）');
  if (!apiKey) throw fail('API_KEY_MISSING', '当前流港预设未保存 Key');
  const endpoint = new URL('/v1/images/generations', preset.baseUrl).href;
  const reader = taskReader({ apiKey, onReceive, stallMs });
  const startedAt = Date.now();
  try {
    const sources = await resolveImageResponse({ task_id: taskId, execution_mode: 'async', assets: [] }, {
      endpoint, apiKey, signal, preferInline: true, makeError: imageError,
      deadline: startedAt + 180_000, request: reader.query, sleep: sleep || promptPolling(),
      onPolling: () => onPolling?.('正在读取流港原任务（不重新生图）…'),
    });
    reader.timing.waitMs = Math.max(0, Date.now() - startedAt - reader.timing.receiveMs);
    onTiming?.({ ...reader.timing });
    return prepareImageDownloads(sources, endpoint, apiKey);
  } catch (error) {
    if (signal?.aborted || error.stalled || !(error instanceof DirectError)) throw error;
    const status = error.status;
    const hint = status === 401 || status === 403 ? '请确认当前预设使用的是生成这张图的 Key'
      : status === 404 ? '流港没有找到这个任务，请核对任务 ID 和 Key'
      : error.code === 'UPSTREAM_TIMEOUT' ? '等候超过 3 分钟仍未取到。可从流港后台下载原图，再点「导入原图」'
      : error.code === 'DIRECT_FETCH_BLOCKED' ? '浏览器没能读到流港的任务结果，请检查网络；也可从后台下载原图后「导入原图」'
      : '';
    if (!hint) throw error;
    throw fail(error.code, `找回图片失败${status > 0 && status !== 504 ? `（HTTP ${status}）` : ''}：${hint}`, status);
  }
}

function authorization(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

const SMART_RETRY_PARAMETERS = Object.freeze([
  ['response_format', /response[_ -]?format/i],
  ['size', /\bsize\b|尺寸/i],
  ['quality', /\bquality\b|质量/i],
  ['n', /(?:parameter|param|field|参数)\s*['"`]?n(?:['"`]|\b)|\bn_samples\b|number of images|张数/i],
]);

const PARAMETER_INCOMPATIBLE = /unsupported|not support|unknown (?:parameter|field)|unrecognized|invalid|unexpected|not allowed|must be|expected|不支持|未知参数|无效|非法|不兼容|不允许/i;
const NEVER_RETRY_REASON = /moderation|content (?:was )?rejected|safety|content policy|内容审核|安全策略|余额|quota|配额/i;

export function detectCompatibilityRetry(error, body = {}) {
  if (!(error instanceof DirectError)
    || error.code !== 'UPSTREAM_HTTP_ERROR'
    || ![400, 422].includes(error.status)) return null;
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

export async function generateImages({
  preset,
  apiKey,
  prompt,
  parameters,
  settings,
  signal,
  onCompatibilityRetry,
  onRetry,
  retryDelays,
  onTimeout,
  onPolling,
  onRequestParameters,
  onReceive,
  onTiming,
  stallMs = 45_000,
}) {
  if (!preset.baseUrl) throw new DirectError('PRESET_NOT_CONFIGURED');
  if (!apiKey) throw new DirectError('API_KEY_MISSING');
  if (!preset.selectedModel) throw new DirectError('MODEL_NOT_SELECTED');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32_000) {
    throw new DirectError('VALIDATION_FAILED', '提示词必须为 1-32000 个字符');
  }
  const endpoint = normalizeEndpoint(preset.baseUrl, preset.generationPath);
  validateEndpoint(endpoint, settings.allowHttp);
  const body = { model: preset.selectedModel, prompt: prompt.trim() };
  if (preset.sendSize) body.size = normalizeImageSize(parameters.size || preset.defaultSize);
  if (preset.sendQuality) body.quality = parameters.quality || preset.defaultQuality;
  if (preset.sendN) body.n = parameters.count || preset.defaultCount;
  /* 默认请求 b64_json 内嵌返回：很多中转站会把图片转成图床 URL，浏览器再去拉那张图时
     常被 CORS 或跳转拦下（尤其手机）。内嵌返回跳过这一步。「额外请求参数 JSON」可覆盖。 */
  const chatEndpoint = /\/chat\/completions$/i.test(new URL(endpoint).pathname);
  const responseFormat = normalizeResponseFormat(preset.responseFormat);
  if (!chatEndpoint && responseFormat) body.response_format = responseFormat;
  Object.assign(body, preset.extraBody || {}, parameters.extraBody || {});
  body.model = preset.selectedModel;
  body.prompt = prompt.trim();
  if ('size' in body) body.size = normalizeImageSize(body.size);
  if (chatEndpoint) {
    body.messages = [{ role: 'user', content: body.prompt }];
    body.stream = false;
    delete body.prompt;
  }
  const fluxPortAsync = preferFluxPortAsync(endpoint, body);
  let submittedAt;

  const keepWaiting = settings?.keepWaitingOnTimeout !== false;
  // Only FluxPort lets a finished task be read again, so only there is a stalled transfer abandoned.
  const fluxPort = isFluxPortPreset(preset);
  const { timing, track, query, noteStall } = taskReader({ apiKey, onReceive, stallMs: fluxPort ? stallMs : 0 });
  const request = payloadBody => {
    submittedAt = Date.now();
    onRequestParameters?.({ size: payloadBody.size ?? null, quality: payloadBody.quality ?? null });
    return fetchJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authorization(apiKey) },
      body: JSON.stringify(payloadBody),
      signal,
    }, preset.timeoutMs, { keepWaiting, onTimeout, neverResend: true, ...track('generate') });
  };
  let compatibilityRetry;
  try {
    let rereading = false;
    let payload;
    try {
      payload = await runGenerationWithRetry({
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
    } catch (caught) {
      if (!caught?.stalled) throw caught;
      // The answer stalled part-way. If its opening lines name the task, read that task again on a
      // new connection; the generation request itself is never repeated.
      noteStall(caught);
      const taskId = /"(?:task_id|taskId|id)"\s*:\s*"(imgtask_[a-z0-9_-]{1,120})"/i.exec(caught.head || '')?.[1];
      delete caught.head;
      if (!taskId) {
        caught.message += '。可到中转站后台复制任务 ID 后点「找回流港图片」，或下载原图后点「导入原图」';
        throw caught;
      }
      rereading = true;
      payload = { task_id: taskId, execution_mode: 'async', assets: [] };
    }
    const timeoutMs = Number(preset.timeoutMs) || 180_000;
    const sources = await resolveImageResponse(payload, {
      endpoint, apiKey, signal, preferInline: body.response_format === 'b64_json',
      onPolling: message => onPolling?.(rereading ? '回包传输停滞，正在换一条连接读取原任务（不重新生图）' : message),
      deadline: rereading ? Date.now() + 180_000 : submittedAt + timeoutMs,
      keepWaiting, onDeadline: () => onTimeout?.(timeoutMs),
      makeError: imageError,
      request: query,
      ...(rereading ? { sleep: promptPolling() } : {}),
    });
    timing.waitMs = Math.max(0, Date.now() - submittedAt - timing.receiveMs);
    onTiming?.({ ...timing });
    return prepareImageDownloads(sources, endpoint, apiKey);
  } catch (error) {
    if (compatibilityRetry) error.compatibilityRetry = compatibilityRetry;
    throw error;
  }
}

export const RESPONSE_FORMATS = Object.freeze(['b64_json', 'url', '']);

export function normalizeResponseFormat(value) {
  if (value === undefined || value === null) return 'b64_json';
  const text = String(value).trim();
  return RESPONSE_FORMATS.includes(text) ? text : 'b64_json';
}

export function rejectsResponseFormat(error) {
  return Boolean(detectCompatibilityRetry(error, { response_format: 'b64_json' })
    ?.adjustedParameters.includes('response_format'));
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

// The SillyTavern upload endpoint already accepts Base64. Inspect only the
// header instead of decoding and encoding an entire upstream image again.
export function inspectBase64Image(value) {
  const raw = String(value).replace(/^data:[^;,]+;base64,/i, '').trim();
  const base64 = /\s/.test(raw) ? raw.replace(/\s+/g, '') : raw;
  if (base64.length < 16 || base64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  let header;
  try {
    const decoded = atob(base64.slice(0, 24));
    header = Uint8Array.from(decoded, character => character.charCodeAt(0));
  } catch {
    return null;
  }
  const type = detectImageType(header);
  if (!type) return null;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return { base64, type, byteSize: (base64.length / 4) * 3 - padding };
}
