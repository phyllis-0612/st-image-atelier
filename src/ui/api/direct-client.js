import {
  DEFAULT_PRESET,
  DEFAULT_SETTINGS,
  MODULE_NAME,
  SCHEMA_VERSION,
} from '../../shared/constants.js';
import {
  DirectError,
  base64ToBytes,
  bytesToBase64,
  detectImageType,
  generateImages,
  listModelsDirect,
} from './openai-direct.js';

const API_KEY_STORAGE = 'stImageAtelier.directApiKey.v1';
const ACTIVE_STATUSES = new Set(['queued', 'generating', 'downloading', 'saving']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function uuid() {
  return globalThis.crypto?.randomUUID?.()
    || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
      const random = Math.floor(Math.random() * 16);
      return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
    });
}

function ensureNamespace(extensionSettings) {
  const previous = extensionSettings[MODULE_NAME];
  const namespace = previous && typeof previous === 'object' ? previous : {};
  namespace.settings = {
    ...clone(DEFAULT_SETTINGS),
    ...(namespace.settings || {}),
    executionMode: namespace.settings?.executionMode || 'direct',
  };
  namespace.preset = {
    ...clone(DEFAULT_PRESET),
    ...(namespace.preset || {}),
    cachedModels: Array.isArray(namespace.preset?.cachedModels) ? namespace.preset.cachedModels : [],
    extraBody: namespace.preset?.extraBody && typeof namespace.preset.extraBody === 'object'
      ? namespace.preset.extraBody
      : {},
    ratioMap: {
      ...clone(DEFAULT_PRESET.ratioMap),
      ...(namespace.preset?.ratioMap || {}),
    },
  };
  namespace.gallery = Array.isArray(namespace.gallery) ? namespace.gallery : [];
  namespace.deletedResultIds = Array.isArray(namespace.deletedResultIds)
    ? namespace.deletedResultIds
    : [];
  namespace.schemaVersion = SCHEMA_VERSION;
  extensionSettings[MODULE_NAME] = namespace;
  return namespace;
}

function maskKey(value) {
  if (!value) return '';
  if (value.length < 8) return '••••••••';
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

function normalizePath(value) {
  const path = String(value || '');
  if (!path || /^(?:https?:|data:|blob:)/i.test(path) || path.startsWith('/')) return path;
  return `/${path.replace(/^\/+/, '')}`;
}

function publicPreset(preset, apiKey) {
  return {
    ...clone(preset),
    hasApiKey: Boolean(apiKey),
    apiKeyMask: maskKey(apiKey),
  };
}

export function createDirectApiClient({
  compat,
  extensionSettings,
  saveSettingsDebounced,
  keyStorage = globalThis.localStorage,
}) {
  const namespace = ensureNamespace(extensionSettings);
  const controllers = new Map();
  const resultIndex = new Map(namespace.gallery.map(result => [result.resultId, result]));
  let memoryKey = '';

  function getApiKey() {
    try {
      return keyStorage?.getItem(API_KEY_STORAGE) || memoryKey;
    } catch {
      return memoryKey;
    }
  }

  function setApiKey(value) {
    memoryKey = value;
    try {
      if (value) keyStorage?.setItem(API_KEY_STORAGE, value);
      else keyStorage?.removeItem(API_KEY_STORAGE);
    } catch {
      // Sandboxed or privacy-restricted browsers can still use the key in this session.
    }
  }

  async function savePreferences() {
    await Promise.resolve(saveSettingsDebounced?.());
  }

  function findTag(tagId) {
    for (const message of compat.chat()) {
      const metadata = message?.extra?.stImageAtelier;
      const tag = metadata?.tags?.find(item => item.tagId === tagId);
      if (tag) return { message, metadata, tag };
    }
    return null;
  }

  function stateOf(tagId) {
    const found = findTag(tagId);
    if (!found) return { tagId, tag: null, attempts: [], results: [] };
    const deleted = new Set(namespace.deletedResultIds);
    const results = (found.tag.results || []).map(result => {
      const next = deleted.has(result.resultId) ? { ...result, status: 'deleted' } : result;
      resultIndex.set(next.resultId, next);
      return next;
    });
    const resultIds = results.filter(result => result.status === 'available').map(result => result.resultId);
    const latestResultId = resultIds.includes(found.tag.latestResultId)
      ? found.tag.latestResultId
      : resultIds.at(-1) || null;
    const tag = {
      ...found.tag,
      resultIds,
      latestResultId,
      autoAttempted: Boolean(found.tag.autoAttempted
        || found.tag.attempts?.some(attempt => attempt.attemptId === `auto:${tagId}`)),
    };
    Object.assign(found.tag, tag);
    return {
      tagId,
      tag: clone(tag),
      attempts: clone(found.tag.attempts || []),
      results: clone(results),
    };
  }

  async function persistAttempt(found, attempt) {
    found.tag.attempts ??= [];
    const index = found.tag.attempts.findIndex(item => item.attemptId === attempt.attemptId);
    if (index >= 0) found.tag.attempts[index] = clone(attempt);
    else found.tag.attempts.unshift(clone(attempt));
    found.tag.attempts = found.tag.attempts.slice(0, 50);
    if (attempt.requestMode === 'auto') found.tag.autoAttempted = true;
    await compat.save();
  }

  async function requestSt(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: compat.headers(),
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new DirectError('LOCAL_SAVE_FAILED', payload?.error || `HTTP ${response.status}`, response.status);
    }
    return payload;
  }

  async function bytesFromSource(source, signal) {
    if (source.sourceType === 'base64') {
      try {
        return base64ToBytes(source.value);
      } catch (error) {
        throw new DirectError('UPSTREAM_RESPONSE_INVALID', error?.message || 'Base64 解码失败');
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), namespace.settings.downloadTimeoutMs);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(source.value, {
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        throw new DirectError('IMAGE_DOWNLOAD_FAILED', `HTTP ${response.status}`, response.status, true);
      }
      const length = Number(response.headers.get('content-length') || 0);
      if (length > namespace.settings.maxImageBytes) {
        throw new DirectError('IMAGE_DOWNLOAD_FAILED', '图片超过 30 MB');
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof DirectError) throw error;
      if (signal?.aborted) throw error;
      throw new DirectError(
        'DIRECT_FETCH_BLOCKED',
        `无法下载图片，可能被浏览器 CORS 阻止：${error?.message || 'Failed to fetch'}`,
        0,
        true,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function saveSource(source, input, attempt, signal) {
    const bytes = await bytesFromSource(source, signal);
    if (bytes.byteLength > namespace.settings.maxImageBytes) {
      throw new DirectError('IMAGE_DOWNLOAD_FAILED', '图片超过 30 MB');
    }
    const type = detectImageType(bytes);
    if (!type) throw new DirectError('UPSTREAM_RESPONSE_INVALID', '仅支持 PNG、JPEG、WebP');
    const resultId = uuid();
    const uploaded = await requestSt('/api/images/upload', {
      image: bytesToBase64(bytes),
      format: type.extension,
      ch_name: 'st-image-atelier',
      filename: resultId,
    });
    return {
      resultId,
      attemptId: attempt.attemptId,
      tagId: input.tagId,
      generationIndex: source.generationIndex,
      chatId: input.chatId,
      messageUuid: input.messageUuid,
      prompt: input.prompt,
      presetId: 'default',
      presetNameSnapshot: namespace.preset.name,
      apiModel: namespace.preset.selectedModel,
      localRelativePath: uploaded.path,
      mimeType: type.mimeType,
      byteSize: bytes.byteLength,
      sourceType: source.sourceType,
      status: 'available',
      storageMode: 'direct',
      createdAt: now(),
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  async function removeFile(result) {
    if (!result?.localRelativePath) return;
    try {
      await requestSt('/api/images/delete', { path: result.localRelativePath });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  async function resolveTags(tagIds) {
    const values = [];
    let changed = false;
    let galleryChanged = false;
    const deleted = new Set(namespace.deletedResultIds);
    for (const tagId of tagIds) {
      const found = findTag(tagId);
      if (found) {
        for (const attempt of found.tag.attempts || []) {
          if (ACTIVE_STATUSES.has(attempt.status) && !controllers.has(attempt.attemptId)) {
            attempt.status = 'interrupted';
            attempt.errorCode = 'ATTEMPT_INTERRUPTED';
            attempt.errorMessage = '生成被中断，请手动重试';
            attempt.completedAt = now();
            changed = true;
          }
        }
        for (const result of found.tag.results || []) {
          if (deleted.has(result.resultId) && result.status !== 'deleted') {
            result.status = 'deleted';
            result.deletedAt ||= now();
            found.tag.autoSuppressed = true;
            changed = true;
          }
          if (result.status === 'available'
            && !namespace.gallery.some(item => item.resultId === result.resultId)) {
            namespace.gallery.push(clone(result));
            resultIndex.set(result.resultId, result);
            galleryChanged = true;
          }
        }
      }
      values.push(stateOf(tagId));
    }
    if (changed) await compat.save();
    if (galleryChanged) await savePreferences();
    return values;
  }

  async function generate(input) {
    const found = findTag(input.tagId);
    if (!found) throw new DirectError('VALIDATION_FAILED', '找不到对应的生图标签');
    const existing = found.tag.attempts?.find(item => item.attemptId === input.attemptId);
    if (existing) return clone(existing);

    const attempt = {
      attemptId: input.attemptId,
      tagId: input.tagId,
      requestMode: input.requestMode,
      presetId: 'default',
      presetNameSnapshot: namespace.preset.name,
      model: namespace.preset.selectedModel,
      parameters: clone(input.parameters || {}),
      status: 'queued',
      resultIds: [],
      errorCode: null,
      errorMessage: null,
      createdAt: now(),
      completedAt: null,
      schemaVersion: SCHEMA_VERSION,
    };

    try {
      await persistAttempt(found, attempt);
    } catch (error) {
      throw new DirectError('LOCAL_SAVE_FAILED', `无法在扣费前保存防重复记录：${error.message}`);
    }

    const controller = new AbortController();
    controllers.set(attempt.attemptId, controller);
    const saved = [];
    try {
      attempt.status = 'generating';
      await persistAttempt(found, attempt);
      const size = namespace.preset.ratioMap?.[input.parameters?.ratio]
        || namespace.preset.defaultSize;
      const sources = await generateImages({
        preset: namespace.preset,
        apiKey: getApiKey(),
        prompt: input.prompt,
        parameters: { ...input.parameters, size },
        settings: namespace.settings,
        signal: controller.signal,
      });

      attempt.status = 'downloading';
      await persistAttempt(found, attempt);
      for (const source of sources) {
        if (controller.signal.aborted) throw controller.signal.reason || new Error('cancelled');
        saved.push(await saveSource(source, input, attempt, controller.signal));
      }

      attempt.status = 'saving';
      await persistAttempt(found, attempt);
      found.tag.results ??= [];
      found.tag.results.push(...saved);
      found.tag.resultIds = found.tag.results
        .filter(result => result.status === 'available')
        .map(result => result.resultId);
      found.tag.latestResultId = saved.at(-1)?.resultId || found.tag.latestResultId || null;
      namespace.gallery.push(...saved);
      for (const result of saved) resultIndex.set(result.resultId, result);
      attempt.status = 'succeeded';
      attempt.resultIds = saved.map(result => result.resultId);
      attempt.completedAt = now();
      await persistAttempt(found, attempt);
      await savePreferences();
      return clone(attempt);
    } catch (error) {
      await Promise.allSettled(saved.map(removeFile));
      const cancelled = controller.signal.aborted;
      attempt.status = cancelled ? 'cancelled' : 'failed';
      attempt.errorCode = cancelled ? null : (error.code || 'UPSTREAM_HTTP_ERROR');
      attempt.errorMessage = cancelled ? '已取消' : (error.message || '生成失败');
      attempt.completedAt = now();
      await persistAttempt(found, attempt).catch(() => {});
      if (cancelled) return clone(attempt);
      throw error;
    } finally {
      controllers.delete(attempt.attemptId);
    }
  }

  async function cancel(attemptId) {
    controllers.get(attemptId)?.abort(new Error('cancelled'));
    for (const message of compat.chat()) {
      for (const tag of message?.extra?.stImageAtelier?.tags || []) {
        const attempt = tag.attempts?.find(item => item.attemptId === attemptId);
        if (!attempt || TERMINAL_STATUSES.has(attempt.status)) continue;
        attempt.status = 'cancelled';
        attempt.errorMessage = '已取消';
        attempt.completedAt = now();
        await compat.save();
        return clone(attempt);
      }
    }
    return null;
  }

  async function gallery({ cursor, limit = 30 } = {}) {
    const start = Math.max(0, Number.parseInt(cursor || '0', 10) || 0);
    const items = namespace.gallery
      .filter(result => result.status === 'available'
        && !namespace.deletedResultIds.includes(result.resultId))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    const page = items.slice(start, start + limit);
    page.forEach(result => resultIndex.set(result.resultId, result));
    return {
      items: clone(page),
      nextCursor: start + limit < items.length ? String(start + limit) : null,
    };
  }

  async function deleteResult(resultId) {
    const result = resultIndex.get(resultId)
      || namespace.gallery.find(item => item.resultId === resultId);
    if (!result) throw new DirectError('VALIDATION_FAILED', '找不到图片');
    await removeFile(result);
    result.status = 'deleted';
    result.deletedAt = now();
    if (!namespace.deletedResultIds.includes(resultId)) namespace.deletedResultIds.push(resultId);
    const found = findTag(result.tagId);
    if (found) {
      const messageResult = found.tag.results?.find(item => item.resultId === resultId);
      if (messageResult) Object.assign(messageResult, { status: 'deleted', deletedAt: result.deletedAt });
      found.tag.resultIds = (found.tag.resultIds || []).filter(id => id !== resultId);
      found.tag.latestResultId = found.tag.resultIds.at(-1) || null;
      found.tag.autoSuppressed = true;
      await compat.save();
    }
    await savePreferences();
    return { resultId, status: 'deleted' };
  }

  function fileUrl(resultId) {
    const result = resultIndex.get(resultId)
      || namespace.gallery.find(item => item.resultId === resultId);
    return normalizePath(result?.localRelativePath);
  }

  return {
    mode: () => namespace.settings.executionMode || 'direct',
    health: async () => ({
      mode: 'direct',
      version: '1.1.0',
      corsRequired: true,
      storage: 'sillytavern-images',
    }),
    getSettings: async () => clone(namespace.settings),
    updateSettings: async patch => {
      Object.assign(namespace.settings, patch, { updatedAt: now(), schemaVersion: SCHEMA_VERSION });
      await savePreferences();
      return clone(namespace.settings);
    },
    getPresets: async () => ({ items: [publicPreset(namespace.preset, getApiKey())] }),
    updatePreset: async patch => {
      if (typeof patch.apiKey === 'string' && patch.apiKey) setApiKey(patch.apiKey);
      const next = { ...patch };
      delete next.apiKey;
      Object.assign(namespace.preset, next, { updatedAt: now(), schemaVersion: SCHEMA_VERSION });
      await savePreferences();
      return publicPreset(namespace.preset, getApiKey());
    },
    clearSecret: async () => {
      setApiKey('');
      return { cleared: true };
    },
    listModels: async () => {
      const models = await listModelsDirect({
        preset: namespace.preset,
        apiKey: getApiKey(),
        settings: namespace.settings,
      });
      namespace.preset.cachedModels = models;
      namespace.preset.modelsFetchedAt = now();
      await savePreferences();
      return { models: clone(models) };
    },
    testPreset: async () => {
      const models = await listModelsDirect({
        preset: namespace.preset,
        apiKey: getApiKey(),
        settings: namespace.settings,
      });
      return { ok: true, modelCount: models.length };
    },
    resolveTags,
    generate,
    attempt: async attemptId => {
      for (const message of compat.chat()) {
        for (const tag of message?.extra?.stImageAtelier?.tags || []) {
          const attempt = tag.attempts?.find(item => item.attemptId === attemptId);
          if (attempt) return clone(attempt);
        }
      }
      throw new DirectError('VALIDATION_FAILED', '找不到生成记录');
    },
    cancel,
    gallery,
    deleteResult,
    fileUrl,
    downloadUrl: fileUrl,
    hasResult: resultId => resultIndex.has(resultId)
      || namespace.gallery.some(item => item.resultId === resultId),
  };
}
