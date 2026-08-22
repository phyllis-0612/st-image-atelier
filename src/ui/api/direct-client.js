import {
  DEFAULT_ARTIST_PRESET,
  DEFAULT_NOVELAI_CONFIG,
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
import { generateNovelAiImages } from './novelai-direct.js';

const LEGACY_API_KEY_STORAGE = 'stImageAtelier.directApiKey.v1';
const API_KEY_STORAGE_PREFIX = 'stImageAtelier.directApiKey.v2:';
const NOVELAI_KEY_STORAGE = 'stImageAtelier.novelAiApiKey.v1';
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

function normalizePreset(value = {}) {
  const preset = {
    ...clone(DEFAULT_PRESET),
    ...value,
    cachedModels: Array.isArray(value.cachedModels) ? value.cachedModels : [],
    extraBody: value.extraBody && typeof value.extraBody === 'object' ? value.extraBody : {},
    ratioMap: {
      ...clone(DEFAULT_PRESET.ratioMap),
      ...(value.ratioMap || {}),
    },
  };
  preset.id = String(preset.id || uuid());
  preset.name = String(preset.name || '未命名预设').trim() || '未命名预设';
  return preset;
}

function normalizeNovelAiConfig(value = {}) {
  return {
    ...clone(DEFAULT_NOVELAI_CONFIG),
    ...value,
    ratioMap: {
      ...clone(DEFAULT_NOVELAI_CONFIG.ratioMap),
      ...(value.ratioMap || {}),
    },
  };
}

function normalizeArtistPreset(value = {}) {
  const preset = { ...clone(DEFAULT_ARTIST_PRESET), ...value };
  preset.id = String(preset.id || uuid());
  preset.name = String(preset.name || '未命名画师串').trim() || '未命名画师串';
  preset.prompt = String(preset.prompt || '').trim();
  return preset;
}

function ensureNamespace(extensionSettings) {
  const previous = extensionSettings[MODULE_NAME];
  const namespace = previous && typeof previous === 'object' ? previous : {};
  namespace.settings = {
    ...clone(DEFAULT_SETTINGS),
    ...(namespace.settings || {}),
    generationProvider: namespace.settings?.generationProvider === 'novelai' ? 'novelai' : 'openai',
    executionMode: namespace.settings?.executionMode || 'direct',
  };
  const sourcePresets = Array.isArray(namespace.presets) && namespace.presets.length
    ? namespace.presets
    : [namespace.preset || DEFAULT_PRESET];
  const seenIds = new Set();
  namespace.presets = sourcePresets.map(value => {
    const preset = normalizePreset(value);
    if (seenIds.has(preset.id)) preset.id = uuid();
    seenIds.add(preset.id);
    return preset;
  });
  namespace.activePresetId = namespace.presets.some(item => item.id === namespace.activePresetId)
    ? namespace.activePresetId
    : namespace.presets[0].id;
  delete namespace.preset;
  namespace.novelAi = normalizeNovelAiConfig(namespace.novelAi);
  const sourceArtistPresets = Array.isArray(namespace.artistPresets) && namespace.artistPresets.length
    ? namespace.artistPresets
    : [DEFAULT_ARTIST_PRESET];
  const artistIds = new Set();
  namespace.artistPresets = sourceArtistPresets.map(value => {
    const preset = normalizeArtistPreset(value);
    if (artistIds.has(preset.id)) preset.id = uuid();
    artistIds.add(preset.id);
    return preset;
  });
  namespace.activeArtistPresetId = namespace.artistPresets
    .some(item => item.id === namespace.activeArtistPresetId)
    ? namespace.activeArtistPresetId
    : namespace.artistPresets[0].id;
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
  const memoryKeys = new Map();

  function presetById(presetId = namespace.activePresetId) {
    return namespace.presets.find(item => item.id === presetId) || null;
  }

  function activePreset() {
    return presetById() || namespace.presets[0];
  }

  function artistPresetById(presetId = namespace.activeArtistPresetId) {
    return namespace.artistPresets.find(item => item.id === presetId) || null;
  }

  function activeArtistPreset() {
    return artistPresetById() || namespace.artistPresets[0];
  }

  function keyStorageName(presetId) {
    return `${API_KEY_STORAGE_PREFIX}${presetId}`;
  }

  function getApiKey(presetId = namespace.activePresetId) {
    const storageName = keyStorageName(presetId);
    try {
      const current = keyStorage?.getItem(storageName);
      if (current) return current;
      if (presetId === 'default') {
        const legacy = keyStorage?.getItem(LEGACY_API_KEY_STORAGE);
        if (legacy) {
          keyStorage?.setItem(storageName, legacy);
          return legacy;
        }
      }
      return memoryKeys.get(presetId) || '';
    } catch {
      return memoryKeys.get(presetId) || '';
    }
  }

  function setApiKey(presetId, value) {
    memoryKeys.set(presetId, value);
    const storageName = keyStorageName(presetId);
    try {
      if (value) keyStorage?.setItem(storageName, value);
      else keyStorage?.removeItem(storageName);
      if (presetId === 'default') keyStorage?.removeItem(LEGACY_API_KEY_STORAGE);
    } catch {
      // Sandboxed or privacy-restricted browsers can still use the key in this session.
    }
  }

  function getNovelAiKey() {
    try {
      return keyStorage?.getItem(NOVELAI_KEY_STORAGE) || memoryKeys.get(NOVELAI_KEY_STORAGE) || '';
    } catch {
      return memoryKeys.get(NOVELAI_KEY_STORAGE) || '';
    }
  }

  function setNovelAiKey(value) {
    const token = String(value || '').trim().replace(/^Bearer\s+/i, '');
    memoryKeys.set(NOVELAI_KEY_STORAGE, token);
    try {
      if (token) keyStorage?.setItem(NOVELAI_KEY_STORAGE, token);
      else keyStorage?.removeItem(NOVELAI_KEY_STORAGE);
    } catch {
      // Keep the token for this page session when storage is unavailable.
    }
  }

  function publicNovelAiConfig() {
    const apiKey = getNovelAiKey();
    return {
      ...clone(namespace.novelAi),
      hasApiKey: Boolean(apiKey),
      apiKeyMask: maskKey(apiKey),
    };
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

  async function persistAttempt(fallbackFound, attempt) {
    const found = findTag(attempt.tagId) || fallbackFound;
    if (!found) throw new DirectError('VALIDATION_FAILED', '找不到对应的生图标签');
    found.tag.attempts ??= [];
    const index = found.tag.attempts.findIndex(item => item.attemptId === attempt.attemptId);
    if (index >= 0) found.tag.attempts[index] = clone(attempt);
    else found.tag.attempts.unshift(clone(attempt));
    found.tag.attempts = found.tag.attempts.slice(0, 50);
    if (attempt.requestMode === 'auto') found.tag.autoAttempted = true;
    await compat.save();
    return found;
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
      resolvedPrompt: attempt.resolvedPrompt || input.prompt,
      provider: attempt.provider || 'openai',
      presetId: attempt.presetId,
      presetNameSnapshot: attempt.presetNameSnapshot,
      artistPresetId: attempt.artistPresetId || null,
      artistPresetNameSnapshot: attempt.artistPresetNameSnapshot || null,
      generationSeed: attempt.generationSeed ?? null,
      apiModel: attempt.model,
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
    let found = findTag(input.tagId);
    if (!found) throw new DirectError('VALIDATION_FAILED', '找不到对应的生图标签');
    const existing = found.tag.attempts?.find(item => item.attemptId === input.attemptId);
    if (existing) return clone(existing);
    const provider = input.provider || namespace.settings.generationProvider || 'openai';
    const preset = provider === 'novelai'
      ? null
      : clone(presetById(input.presetId) || activePreset());
    if (provider !== 'novelai' && !preset) {
      throw new DirectError('PRESET_NOT_CONFIGURED', '找不到所选 API 预设');
    }
    const novelAi = provider === 'novelai' ? clone(namespace.novelAi) : null;
    const artistPreset = provider === 'novelai'
      ? clone(artistPresetById(input.artistPresetId) || activeArtistPreset())
      : null;
    if (provider === 'novelai' && !artistPreset) {
      throw new DirectError('PRESET_NOT_CONFIGURED', '找不到所选画师串预设');
    }
    const apiKey = provider === 'novelai' ? getNovelAiKey() : getApiKey(preset.id);
    const requestedSize = provider === 'novelai'
      ? (novelAi.ratioMap?.[input.parameters?.ratio] || novelAi.defaultSize)
      : (preset.ratioMap?.[input.parameters?.ratio] || preset.defaultSize);

    const attempt = {
      attemptId: input.attemptId,
      tagId: input.tagId,
      requestMode: input.requestMode,
      provider,
      presetId: provider === 'novelai' ? 'novelai' : preset.id,
      presetNameSnapshot: provider === 'novelai' ? 'NovelAI' : preset.name,
      artistPresetId: artistPreset?.id || null,
      artistPresetNameSnapshot: artistPreset?.name || null,
      model: provider === 'novelai' ? novelAi.model : preset.selectedModel,
      parameters: { ...clone(input.parameters || {}), size: requestedSize },
      status: 'generating',
      resultIds: [],
      errorCode: null,
      errorMessage: null,
      createdAt: now(),
      completedAt: null,
      schemaVersion: SCHEMA_VERSION,
    };

    const controller = new AbortController();
    controllers.set(attempt.attemptId, controller);
    try {
      found = await persistAttempt(found, attempt);
    } catch (error) {
      controllers.delete(attempt.attemptId);
      throw new DirectError('LOCAL_SAVE_FAILED', `无法在扣费前保存防重复记录：${error.message}`);
    }

    const saved = [];
    try {
      let sources;
      if (provider === 'novelai') {
        const generated = await generateNovelAiImages({
          config: novelAi,
          apiKey,
          artistPrompt: artistPreset.prompt,
          prompt: input.prompt,
          parameters: attempt.parameters,
          settings: namespace.settings,
          signal: controller.signal,
        });
        sources = generated.sources;
        attempt.resolvedPrompt = generated.resolvedPrompt;
        attempt.generationSeed = generated.seed;
      } else {
        sources = await generateImages({
          preset,
          apiKey,
          prompt: input.prompt,
          parameters: attempt.parameters,
          settings: namespace.settings,
          signal: controller.signal,
        });
      }

      attempt.status = 'downloading';
      found = await persistAttempt(found, attempt);
      for (const source of sources) {
        if (controller.signal.aborted) throw controller.signal.reason || new Error('cancelled');
        saved.push(await saveSource(source, input, attempt, controller.signal));
      }

      attempt.status = 'saving';
      found = await persistAttempt(found, attempt);
      found = findTag(input.tagId) || found;
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
      found = await persistAttempt(found, attempt);
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
      version: '1.4.1',
      corsRequired: true,
      storage: 'sillytavern-images',
    }),
    getSettings: async () => clone(namespace.settings),
    updateSettings: async patch => {
      Object.assign(namespace.settings, patch, { updatedAt: now(), schemaVersion: SCHEMA_VERSION });
      await savePreferences();
      return clone(namespace.settings);
    },
    getPresets: async () => ({
      activePresetId: namespace.activePresetId,
      items: namespace.presets.map(preset => publicPreset(preset, getApiKey(preset.id))),
    }),
    getNovelAi: async () => ({
      config: publicNovelAiConfig(),
      activeArtistPresetId: namespace.activeArtistPresetId,
      artistPresets: clone(namespace.artistPresets),
    }),
    updateNovelAi: async patch => {
      if (typeof patch?.apiKey === 'string' && patch.apiKey) setNovelAiKey(patch.apiKey);
      const next = { ...patch };
      delete next.apiKey;
      Object.assign(namespace.novelAi, normalizeNovelAiConfig({ ...namespace.novelAi, ...next }), {
        updatedAt: now(),
        schemaVersion: SCHEMA_VERSION,
      });
      await savePreferences();
      return publicNovelAiConfig();
    },
    clearNovelAiSecret: async () => {
      setNovelAiKey('');
      return { cleared: true };
    },
    selectArtistPreset: async presetId => {
      const preset = artistPresetById(presetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到所选画师串预设');
      namespace.activeArtistPresetId = preset.id;
      await savePreferences();
      return clone(preset);
    },
    createArtistPreset: async ({ name = '新画师串', prompt = '' } = {}) => {
      const timestamp = now();
      const preset = normalizeArtistPreset({
        id: uuid(),
        name,
        prompt,
        createdAt: timestamp,
        updatedAt: timestamp,
        schemaVersion: SCHEMA_VERSION,
      });
      namespace.artistPresets.push(preset);
      namespace.activeArtistPresetId = preset.id;
      await savePreferences();
      return clone(preset);
    },
    updateArtistPreset: async (presetId, patch) => {
      const preset = artistPresetById(presetId || namespace.activeArtistPresetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到要保存的画师串预设');
      Object.assign(preset, normalizeArtistPreset({ ...preset, ...patch }), {
        id: preset.id,
        updatedAt: now(),
        schemaVersion: SCHEMA_VERSION,
      });
      await savePreferences();
      return clone(preset);
    },
    deleteArtistPreset: async presetId => {
      if (namespace.artistPresets.length <= 1) {
        throw new DirectError('VALIDATION_FAILED', '至少需要保留一个画师串预设');
      }
      const index = namespace.artistPresets.findIndex(item => item.id === presetId);
      if (index < 0) throw new DirectError('VALIDATION_FAILED', '找不到要删除的画师串预设');
      namespace.artistPresets.splice(index, 1);
      if (namespace.activeArtistPresetId === presetId) {
        namespace.activeArtistPresetId = namespace.artistPresets[
          Math.min(index, namespace.artistPresets.length - 1)
        ].id;
      }
      await savePreferences();
      return { deleted: true, activeArtistPreset: clone(activeArtistPreset()) };
    },
    selectPreset: async presetId => {
      const preset = presetById(presetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到所选 API 预设');
      namespace.activePresetId = preset.id;
      await savePreferences();
      return publicPreset(preset, getApiKey(preset.id));
    },
    createPreset: async ({ name = '新预设' } = {}) => {
      const timestamp = now();
      const preset = normalizePreset({
        ...clone(DEFAULT_PRESET),
        id: uuid(),
        name,
        createdAt: timestamp,
        updatedAt: timestamp,
        schemaVersion: SCHEMA_VERSION,
      });
      namespace.presets.push(preset);
      namespace.activePresetId = preset.id;
      await savePreferences();
      return publicPreset(preset, '');
    },
    updatePreset: async (presetId, patch) => {
      if (patch == null && presetId && typeof presetId === 'object') {
        patch = presetId;
        presetId = namespace.activePresetId;
      }
      const preset = presetById(presetId || namespace.activePresetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到要保存的 API 预设');
      if (typeof patch?.apiKey === 'string' && patch.apiKey) setApiKey(preset.id, patch.apiKey);
      const next = { ...patch };
      delete next.apiKey;
      delete next.id;
      Object.assign(preset, normalizePreset({ ...preset, ...next }), {
        id: preset.id,
        updatedAt: now(),
        schemaVersion: SCHEMA_VERSION,
      });
      await savePreferences();
      return publicPreset(preset, getApiKey(preset.id));
    },
    deletePreset: async presetId => {
      if (namespace.presets.length <= 1) {
        throw new DirectError('VALIDATION_FAILED', '至少需要保留一个 API 预设');
      }
      const index = namespace.presets.findIndex(item => item.id === presetId);
      if (index < 0) throw new DirectError('VALIDATION_FAILED', '找不到要删除的 API 预设');
      const [removed] = namespace.presets.splice(index, 1);
      setApiKey(removed.id, '');
      if (namespace.activePresetId === removed.id) {
        namespace.activePresetId = namespace.presets[Math.min(index, namespace.presets.length - 1)].id;
      }
      await savePreferences();
      return {
        deleted: true,
        activePreset: publicPreset(activePreset(), getApiKey(namespace.activePresetId)),
      };
    },
    clearSecret: async presetId => {
      const preset = presetById(presetId || namespace.activePresetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到所选 API 预设');
      setApiKey(preset.id, '');
      return { cleared: true };
    },
    listModels: async presetId => {
      const preset = presetById(presetId || namespace.activePresetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到所选 API 预设');
      const models = await listModelsDirect({
        preset,
        apiKey: getApiKey(preset.id),
        settings: namespace.settings,
      });
      preset.cachedModels = models;
      preset.modelsFetchedAt = now();
      await savePreferences();
      return { models: clone(models) };
    },
    testPreset: async presetId => {
      const preset = presetById(presetId || namespace.activePresetId);
      if (!preset) throw new DirectError('VALIDATION_FAILED', '找不到所选 API 预设');
      const models = await listModelsDirect({
        preset,
        apiKey: getApiKey(preset.id),
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
