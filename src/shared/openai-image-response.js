// The standalone Server Plugin keeps its own copy (see direct-adapter tests). The 1.6.20 receive fixes
// (result download budget, keep-waiting polls, uncertain results) are browser-direct only for now.
const CONTAINERS = ['assets', 'images', 'data', 'result', 'output', 'response'];
const LINKS = ['signed_url', 'url', 'image_url', 'image', 'asset_url', 'download_url'];
const B64 = ['b64_json', 'base64', 'image_base64', 'b64'];
const DATA_IMAGE = /^data:image\/[\w.+-]+;base64,/i;
const IMAGE_PREFIX = /^(?:iVBORw0KGgo|\/9j\/|UklGR)/;
const FAILURE = /^(failed|failure|error|cancelled|canceled|expired|rejected)$/i;
const DONE = /^(completed|complete|succeeded|success|finished|done)$/i;

function source(value, allowBase64 = false) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (DATA_IMAGE.test(text)) {
    const data = text.replace(DATA_IMAGE, '');
    return data ? { sourceType: 'base64', value: data } : null;
  }
  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      if (!parsed.username && !parsed.password && !/\s/.test(text)) return { sourceType: 'url', value: text };
    } catch { /* Not a link. */ }
  }
  if (IMAGE_PREFIX.test(text) || (allowBase64 && /^[a-z\d+/=\s]+$/i.test(text))) {
    return { sourceType: 'base64', value: text };
  }
  return null;
}

export function imageSources(payload, taskOrigin, includeAssets = true) {
  const results = [];
  const seen = new Set();
  const add = item => {
    if (!item || seen.has(item.value)) return;
    seen.add(item.value);
    results.push({ ...item, generationIndex: results.length });
  };
  function readText(text) {
    // Prefer explicit Markdown images when the message also contains links to docs or a website.
    const markdown = [...text.matchAll(/!\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)];
    const links = markdown.map(match => source(match[1] || match[2])).filter(Boolean);
    if (links.length) { links.forEach(add); return; }
    for (const match of text.matchAll(/(?:https?:\/\/|data:image\/)[^\s<>"'`]+/gi)) {
      add(source(match[0].replace(/[)\]，。；！？.,;!?]+$/, '')));
    }
  }
  function read(value, depth = 0) {
    if (depth > 10 || value == null) return;
    if (typeof value === 'string') { add(source(value)); return; }
    if (Array.isArray(value)) { for (const item of value) read(item, depth + 1); return; }
    if (typeof value !== 'object') return;
    // Image objects may offer both a URL and Base64. Keep the embedded image.
    for (const key of B64) {
      const item = source(value[key], true);
      if (item) { add(item); return; }
    }
    for (const key of LINKS) {
      const entry = value[key];
      let item = source(typeof entry === 'object' ? entry?.url : entry);
      if (!item && taskOrigin && typeof entry === 'string' && entry.startsWith('/v1/images/tasks/') && !/\s/.test(entry)) {
        item = { sourceType: 'url', value: new URL(entry, taskOrigin).href };
      }
      if (item) {
        if (key === 'signed_url' && taskOrigin && item.sourceType === 'url') {
          item.signed = true;
          const protectedUrl = [value.url, value.download_url].map(value => {
            if (typeof value !== 'string' || /\s/.test(value)) return null;
            return trustedTaskUrl(value, new URL(taskOrigin));
          }).find(url => url?.pathname.startsWith('/v1/images/tasks/') && url.href !== item.value);
          if (protectedUrl) item.fallbackUrl = protectedUrl.href;
        }
        add(item);
        return;
      }
      if (entry && typeof entry === 'object') {
        const before = results.length;
        read(entry, depth + 1);
        if (results.length > before) return;
      }
    }
    for (const key of CONTAINERS) if (key !== 'assets' || includeAssets) read(value[key], depth + 1);
    const messages = [value.message, ...(Array.isArray(value.choices) ? value.choices.map(choice => choice?.message) : [])];
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      read(message.images, depth + 1);
      const content = message.content;
      if (typeof content === 'string') readText(content);
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part?.text === 'string') readText(part.text);
          else read(part, depth + 1);
        }
      }
    }
  }
  read(payload);
  return results;
}

function taskEnvelope(payload, isPoll = false, depth = 0) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || depth > 6) return null;
  const explicit = payload.task_id ?? payload.taskId;
  const asyncMode = String(payload.execution_mode || '').toLowerCase() === 'async';
  if ((!isPoll && (explicit != null || asyncMode)) || (isPoll && 'assets' in payload)) {
    return { record: payload, id: explicit ?? (asyncMode ? payload.id : null) };
  }
  for (const key of ['data', 'result', 'output', 'response', 'task']) {
    const task = taskEnvelope(payload[key], isPoll, depth + 1);
    if (task) return task;
  }
  if (isPoll && (explicit != null || asyncMode || 'status' in payload || 'state' in payload || 'task_status' in payload)) {
    return { record: payload, id: explicit ?? payload.id };
  }
  return null;
}

function isFluxPort(url) {
  return url.protocol === 'https:' && ['api.uselg.top', 'api.ai-media.vip'].includes(url.host);
}

export function preferFluxPortAsync(endpoint, body) {
  const url = new URL(endpoint);
  if (isFluxPort(url) && url.pathname === '/v1/images/generations'
    && !Object.hasOwn(body, 'async') && body.stream !== true) body.async = true;
  return isFluxPort(url) && body.async === true;
}

function trustedTaskUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, base.origin);
    if (url.origin === base.origin && !url.username && !url.password && !url.hash) return url;
  } catch { /* Ignore malformed addresses. */ }
  return null;
}

// Only the configured FluxPort API origin and the current task's asset route may receive its key.
export function imageDownloadAuthorization(source, endpoint, apiKey) {
  if (source.sourceType !== 'url' || !source.assetTaskId) return undefined;
  const base = new URL(endpoint);
  const url = new URL(source.value);
  if (isFluxPort(base) && url.origin === base.origin
      && url.pathname.startsWith(`/v1/images/tasks/${encodeURIComponent(source.assetTaskId)}/assets/`)) {
    return `Bearer ${apiKey}`;
  }
  return undefined;
}

export function prepareImageDownloads(sources, endpoint, apiKey) {
  return sources.map(({ assetTaskId, fallbackUrl, signed, ...source }) => {
    const authorization = !signed && imageDownloadAuthorization({ ...source, assetTaskId }, endpoint, apiKey);
    if (authorization) source.authorization = authorization;
    if (fallbackUrl) {
      const fallback = { sourceType: 'url', value: fallbackUrl, assetTaskId };
      const fallbackAuthorization = imageDownloadAuthorization(fallback, endpoint, apiKey);
      if (fallbackAuthorization) source.fallback = { sourceType: 'url', value: fallbackUrl, authorization: fallbackAuthorization };
    }
    return source;
  });
}

export function responseDiagnostic(payload, apiKey = '') {
  const sensitive = /authorization|api[_-]?key|cookie|password|secret|access[_-]?token|refresh[_-]?token|signed[_-]?url|^(?:key|token|headers|prompt|input)$/i;
  let budget = 6500;
  function cleanText(value) {
    const clipped = value.length > 4500;
    let result = clipped ? value.slice(0, 4500 + apiKey.length) : value;
    if (apiKey) result = result.split(apiKey).join('[已隐藏密钥]');
    return result
      .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [已隐藏]')
      .replace(/\b(?:sk|key)-[a-z\d._-]{6,}/gi, '[已隐藏密钥]')
      .replace(/(\b(?:api[_-]?key|password|secret|token)["']?\s*[:=]\s*)["']?[^\s"',}<]+/gi, '$1[已隐藏]')
      .replace(/data:image\/[^\s"',)]+/gi, '[图片数据已省略]')
      .replace(/https?:\/\/[^\s"'<>]+/gi, link => {
        try {
          const url = new URL(link);
          const path = url.pathname.replace(/(\/downloads\/)[^/]+(?=\/)/i, '$1［下载凭据已隐藏］');
          return `${url.origin}${path}${url.search || url.hash ? '［链接参数已隐藏］' : ''}`;
        } catch { return '[链接已省略]'; }
      })
      .replace(/[A-Za-z0-9+/=]{160,}/g, '[长编码已省略]') + (clipped ? '…［内容过长，后续已省略］' : '');
  }
  function clean(value, depth = 0) {
    budget -= 8;
    if (budget <= 0) return '[其余内容已省略]';
    if (typeof value === 'string') {
      const text = cleanText(value);
      budget -= text.length;
      return text;
    }
    if (!value || typeof value !== 'object') return value;
    if (depth >= 12) return '[更深内容已省略]';
    if (Array.isArray(value)) return value.slice(0, 100).map(item => clean(item, depth + 1))
      .concat(value.length > 100 ? ['[其余项目已省略]'] : []);
    const entries = [];
    for (const key of Object.keys(value)) {
      if (budget <= 0) { entries.push(['…', '[其余字段已省略]']); break; }
      budget -= key.length + 12;
      entries.push([cleanText(key), sensitive.test(key) ? '[已隐藏]' : B64.includes(key.toLowerCase()) ? '[图片数据已省略]' : clean(value[key], depth + 1)]);
    }
    return Object.fromEntries(entries);
  }
  const safe = clean(payload);
  const text = typeof safe === 'string' ? safe : JSON.stringify(safe) ?? '（空响应）';
  return text.length > 4000 ? text.slice(0, 4000) + '…［响应过长，后续已省略］' : text;
}

const UNCERTAIN = /^(uncertain|unknown|unconfirmed)$/i;

// A gateway may say "the result is unknown, do not poll, do not resubmit". Returns the record when it does.
export function stopNotice(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || depth > 4) return null;
  const state = String(payload.status ?? payload.state ?? payload.task_status ?? '').trim();
  const code = String(payload.error_code ?? payload.code ?? payload.error?.code ?? '');
  if (UNCERTAIN.test(state) || /uncertain/i.test(code)
    || (payload.auto_poll === false && payload.retryable === false)) return payload;
  for (const key of ['data', 'result', 'output', 'response', 'task', 'error']) {
    const found = stopNotice(payload[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function stopNoticeMessage(record, apiKey = '') {
  const redact = value => {
    let text = String(value || '');
    if (apiKey) text = text.split(apiKey).join('[已隐藏密钥]');
    return text.replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [已隐藏]')
      .replace(/\b(?:sk|key)-[A-Za-z0-9._-]{6,}\b/g, '[已隐藏密钥]');
  };
  const code = redact(record.error_code ?? record.code ?? record.error?.code ?? '').slice(0, 80);
  const raw = record.error_message ?? record.message ?? record.detail ?? record.error?.message
    ?? (typeof record.error === 'string' ? record.error : '');
  const reason = redact(raw).replace(/\s+/g, ' ').trim().slice(0, 200);
  return `中转站没能确认这次生图的结果${code ? `（${code}）` : ''}${reason ? `：${reason}` : ''}。`
    + '站方要求不要自动查询或重发，画笺已停止；请先到中转站后台核对是否出图或扣费，再决定是否重绘';
}

function waitForPoll(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function resolveImageResponse(payload, {
  endpoint, apiKey, request, signal, deadline, onPolling, makeError, preferInline = false, sleep = waitForPoll,
  keepWaiting = false, onDeadline, resultTimeoutMs = 180_000, maxWaitMs = 30 * 60_000,
}) {
  const error = (code, message, status = 400, response = payload) =>
    makeError(code, `${message}；上游响应：${responseDiagnostic(response, apiKey)}`, status);
  const base = new URL(endpoint);
  const fluxPort = isFluxPort(base);
  const task = taskEnvelope(payload);
  const asyncMode = String(task?.record.execution_mode || '').toLowerCase() === 'async';
  const status = record => String(record?.status ?? record?.state ?? record?.task_status ?? '').trim();
  const preferTaskResult = fluxPort && preferInline;
  // Some synchronous gateways attach a task ID to images that are already available.
  const immediate = imageSources(asyncMode ? task.record.assets : payload, task ? base.origin : undefined);
  const initialStatus = status(task?.record);
  const alreadyDone = DONE.test(initialStatus);
  const preferFullInitial = task && preferTaskResult && immediate.some(item => item.sourceType === 'url')
    && (alreadyDone || !initialStatus && task.record.result_url);
  if (immediate.length && !preferFullInitial && !(fluxPort && asyncMode && initialStatus && !alreadyDone)) {
    return task ? immediate.map(item => ({ ...item, assetTaskId: task.id })) : immediate;
  }
  const stopped = stopNotice(payload);
  if (stopped) throw error('UPSTREAM_HTTP_ERROR', stopNoticeMessage(stopped, apiKey), 502);
  if (!task) throw error('UPSTREAM_RESPONSE_INVALID', '响应中没有可识别的图片');
  const id = typeof task.id === 'number' && Number.isSafeInteger(task.id) ? String(task.id) : task.id;
  if (typeof id !== 'string' || !/^[\w-][\w.:-]{0,255}$/.test(id)) {
    throw error('UPSTREAM_RESPONSE_INVALID', '异步任务缺少有效的任务 ID');
  }
  if (task.record.auto_poll === false && !DONE.test(status(task.record))) {
    throw error('UPSTREAM_RESPONSE_INVALID', '中转站要求停止查询，请在中转站核对原任务，先不要重绘');
  }
  if (FAILURE.test(status(task.record))) throw error('UPSTREAM_HTTP_ERROR', '中转站异步任务失败', 502);
  const legacy = new URL(base);
  legacy.pathname = fluxPort ? `/v1/images/tasks/${encodeURIComponent(id)}`
    : `${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(id)}`;
  const url = trustedTaskUrl(task.record.status_url ?? task.record.poll_url, base) ?? legacy;
  const withAssetTask = sources => sources.map(item => ({ ...item, assetTaskId: id }));
  const receiptResultUrl = trustedTaskUrl(task.record.result_url, base) ?? (fluxPort ? legacy : null);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let last = payload;
  // `limit` is when the work in progress is abandoned. It starts as the preset deadline, which only
  // covers queueing and drawing: a finished task always gets `resultTimeoutMs` to hand over its image.
  let limit = deadline;
  let timer;
  let extended = false;
  const remaining = () => limit - Date.now();
  const timeout = () => error('UPSTREAM_TIMEOUT', '中转站异步任务超过预设等待时间', 504, last);
  // "Keep waiting" turns the preset deadline into a reminder, as it does for synchronous requests.
  function keepGoing() {
    if (!keepWaiting || extended || controller.signal.aborted) return false;
    extended = true;
    arm(Math.max(Date.now(), deadline) + maxWaitMs);
    Promise.resolve().then(() => onDeadline?.()).catch(() => {});
    return true;
  }
  let inFlightSince = 0;
  // A download that is visibly making progress is not cut off: each report of real progress renews
  // its allowance, up to `maxWaitMs` in total. A stalled one still ends when the allowance runs out.
  const hardStop = Date.now() + maxWaitMs;
  let collecting = false;
  const touch = () => {
    if (controller.signal.aborted || Date.now() >= hardStop) return;
    if (inFlightSince) inFlightSince = Date.now();
    else if (collecting) arm(Math.min(Date.now() + resultTimeoutMs, hardStop));
  };
  function schedule(at) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (keepGoing()) return;
      // A query that is already under way may be carrying the finished image (some gateways answer
      // the status query with the whole result), so it gets the result allowance before being cut.
      const grace = inFlightSince ? Math.min(inFlightSince + resultTimeoutMs, hardStop) : 0;
      if (grace > Date.now()) schedule(grace);
      else controller.abort(timeout());
    }, Math.max(0, at - Date.now()));
  }
  function arm(at) {
    limit = Math.min(at, hardStop);
    schedule(limit);
  }
  const expired = () => remaining() <= 0 && !keepGoing();
  arm(deadline);
  async function finish(record, images, fetchedUrl) {
    const resultUrl = trustedTaskUrl(record?.result_url, base) ?? receiptResultUrl;
    const wantInline = preferTaskResult && images.some(item => item.sourceType === 'url');
    if (images.length && !wantInline) return withAssetTask(images);

    let result = last;
    if (resultUrl && resultUrl.href !== fetchedUrl) {
      // The image exists now. Downloading it must not be cut short by time spent queueing and drawing.
      // With links already in hand the inline copy is only an upgrade: never extend that wait further.
      extended = true;
      if (!controller.signal.aborted) arm(Date.now() + resultTimeoutMs);
      try {
        collecting = true;
        result = await request(resultUrl.href, controller.signal, { result: true, touch });
        if (controller.signal.aborted) throw controller.signal.reason;
      } catch (error) {
        // The summary already gave us usable links. An optional full result request must not lose them.
        if (images.length && !signal?.aborted) return withAssetTask(images);
        throw controller.signal.aborted ? controller.signal.reason : error;
      }
    }
    const normalized = imageSources(result, base.origin, false);
    if (normalized.length && (!images.length || (normalized.length >= images.length
      && normalized.filter(item => item.sourceType === 'base64').length > images.filter(item => item.sourceType === 'base64').length))) {
      return withAssetTask(normalized);
    }
    if (images.length) return withAssetTask(images);
    const full = imageSources(result, base.origin);
    if (full.length) return withAssetTask(full);
    throw error('UPSTREAM_RESPONSE_INVALID', '任务已完成，但结果中没有可识别的图片', 400, result);
  }

  try {
    // A finished task is collected even when its receipt arrived after the preset deadline.
    if (preferFullInitial || alreadyDone) return await finish(task.record, immediate, null);
    if (expired()) throw timeout();
    if (controller.signal.aborted) throw controller.signal.reason;
    await onPolling?.('中转站在后台排队画');
    const delayHint = record => Math.min(10_000, Math.max(2000, Number(record?.poll_after_ms) || 2000));
    for (let delay = delayHint(task.record); ; delay = Math.min(10_000, Math.max(Math.ceil(delay * 1.5), delayHint(last)))) {
      if (expired()) throw timeout();
      await sleep(Math.max(0, Math.min(delay, remaining())), controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (expired()) throw timeout();
      inFlightSince = Date.now();
      try {
        last = await request(url.toString(), controller.signal, { result: false, touch });
      } catch (e) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (e.retryable) continue; // Retry the status query, never the generation POST.
        throw e;
      } finally {
        inFlightSince = 0;
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      const record = taskEnvelope(last, true)?.record ?? last;
      if (FAILURE.test(status(record))) throw error('UPSTREAM_HTTP_ERROR', '中转站异步任务失败', 502, last);
      const images = imageSources(record?.assets, base.origin);
      if (DONE.test(status(record))) return await finish(record, images, url.href);
      if (images.length && (!fluxPort || !status(record))) return await finish(record, images, url.href);
      if (!status(record)) {
        const carried = imageSources(last, base.origin);
        if (carried.length) return withAssetTask(carried);
      }
      const halted = stopNotice(last);
      if (halted) throw error('UPSTREAM_HTTP_ERROR', stopNoticeMessage(halted, apiKey), 502, last);
      if (record?.auto_poll === false) {
        throw error('UPSTREAM_RESPONSE_INVALID', '中转站要求停止查询，请在中转站核对原任务，先不要重绘', 400, last);
      }
      if (!record || typeof record !== 'object' || !['assets', 'status', 'state', 'task_status', 'execution_mode', 'task_id', 'taskId'].some(key => key in record)) {
        throw error('UPSTREAM_RESPONSE_INVALID', '任务查询响应格式不兼容', 400, last);
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
