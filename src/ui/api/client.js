import { API_ROOT } from '../../shared/constants.js';
import { createDirectApiClient } from './direct-client.js';

export class ApiError extends Error {
  constructor(error, status) {
    super(error?.message || '服务端请求失败');
    this.code = error?.code || 'SERVER_PLUGIN_UNAVAILABLE';
    this.retryable = Boolean(error?.retryable);
    this.details = error?.details;
    this.status = status;
  }
}

export function createServerApiClient(compat) {
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(`${API_ROOT}${path}`, {
        credentials: 'same-origin',
        ...options,
        headers: {
          ...compat.headers({ json: options.body != null }),
          ...(options.headers || {}),
        },
      });
    } catch {
      throw new ApiError({
        code: 'SERVER_PLUGIN_UNAVAILABLE',
        message: '服务端插件不可用，请确认已启用 Server Plugins 并重启 SillyTavern',
      }, 503);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new ApiError(payload?.error || {
        code: 'SERVER_PLUGIN_UNAVAILABLE',
        message: `服务端返回异常（HTTP ${response.status}）`,
      }, response.status);
    }
    return payload.data;
  }

  const json = value => JSON.stringify(value);
  return {
    health: () => request('/health'),
    getSettings: () => request('/settings'),
    updateSettings: patch => request('/settings', { method: 'PATCH', body: json(patch) }),
    getPresets: () => request('/presets'),
    updatePreset: (presetId, patch) => request(`/presets/${encodeURIComponent(presetId)}`, {
      method: 'PATCH',
      body: json(patch),
    }),
    clearSecret: presetId => request(`/presets/${encodeURIComponent(presetId)}/clear-secret`, {
      method: 'POST',
      body: '{}',
    }),
    listModels: presetId => request(`/presets/${encodeURIComponent(presetId)}/models`, {
      method: 'POST',
      body: '{}',
    }),
    testPreset: presetId => request(`/presets/${encodeURIComponent(presetId)}/test`, {
      method: 'POST',
      body: '{}',
    }),
    resolveTags: tagIds => request('/tags/resolve', { method: 'POST', body: json({ tagIds }) }),
    generate: input => request('/generate', { method: 'POST', body: json(input) }),
    attempt: attemptId => request(`/attempts/${encodeURIComponent(attemptId)}`),
    cancel: attemptId => request(`/attempts/${encodeURIComponent(attemptId)}/cancel`, { method: 'POST', body: '{}' }),
    gallery: ({ cursor, limit = 30 } = {}) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set('cursor', cursor);
      return request(`/gallery?${query}`);
    },
    deleteResult: resultId => request(`/gallery/${encodeURIComponent(resultId)}`, { method: 'DELETE' }),
    fileUrl: resultId => `${API_ROOT}/gallery/${encodeURIComponent(resultId)}/file`,
    downloadUrl: resultId => `${API_ROOT}/gallery/${encodeURIComponent(resultId)}/download`,
  };
}

export function createApiClient({
  compat,
  extensionSettings,
  saveSettingsDebounced,
  keyStorage,
}) {
  const direct = createDirectApiClient({
    compat,
    extensionSettings,
    saveSettingsDebounced,
    keyStorage,
  });
  const server = createServerApiClient(compat);
  const selected = () => direct.mode() === 'server' ? server : direct;

  async function getSettings() {
    const local = await direct.getSettings();
    if (direct.mode() !== 'server') return local;
    const remote = await server.getSettings();
    return { ...remote, executionMode: 'server' };
  }

  async function updateSettings(patch) {
    const requestedMode = patch.executionMode || direct.mode();
    if (Object.hasOwn(patch, 'generationProvider')) {
      await direct.updateSettings({ generationProvider: patch.generationProvider });
    }
    if (requestedMode !== direct.mode()) {
      await direct.updateSettings({ executionMode: requestedMode });
    }
    if (requestedMode === 'direct') return direct.updateSettings(patch);
    const remotePatch = { ...patch };
    delete remotePatch.executionMode;
    delete remotePatch.generationProvider;
    const remote = Object.keys(remotePatch).length
      ? await server.updateSettings(remotePatch)
      : await server.getSettings();
    return { ...remote, executionMode: 'server' };
  }

  return {
    health: () => selected().health(),
    getSettings,
    updateSettings,
    getPresets: () => selected().getPresets(),
    getNovelAi: () => direct.getNovelAi(),
    updateNovelAi: patch => direct.updateNovelAi(patch),
    clearNovelAiSecret: () => direct.clearNovelAiSecret(),
    selectArtistPreset: presetId => direct.selectArtistPreset(presetId),
    createArtistPreset: input => direct.createArtistPreset(input),
    updateArtistPreset: (presetId, patch) => direct.updateArtistPreset(presetId, patch),
    deleteArtistPreset: presetId => direct.deleteArtistPreset(presetId),
    selectPreset: presetId => direct.mode() === 'direct'
      ? direct.selectPreset(presetId)
      : server.getPresets().then(data => data.items.find(item => item.id === presetId)),
    createPreset: input => {
      if (direct.mode() !== 'direct') {
        throw new ApiError({ message: '多 API 预设目前用于免服务端直连模式' }, 400);
      }
      return direct.createPreset(input);
    },
    updatePreset: (presetId, patch) => selected().updatePreset(presetId, patch),
    deletePreset: presetId => {
      if (direct.mode() !== 'direct') {
        throw new ApiError({ message: '多 API 预设目前用于免服务端直连模式' }, 400);
      }
      return direct.deletePreset(presetId);
    },
    clearSecret: presetId => selected().clearSecret(presetId),
    listModels: presetId => selected().listModels(presetId),
    testPreset: presetId => selected().testPreset(presetId),
    resolveTags: tagIds => selected().resolveTags(tagIds),
    generate: input => input.provider === 'novelai'
      ? direct.generate(input)
      : selected().generate(input),
    attempt: attemptId => selected().attempt(attemptId),
    cancel: attemptId => selected().cancel(attemptId),
    gallery: options => selected().gallery(options),
    deleteResult: resultId => selected().deleteResult(resultId),
    fileUrl: resultId => direct.hasResult(resultId)
      ? direct.fileUrl(resultId)
      : server.fileUrl(resultId),
    downloadUrl: resultId => direct.hasResult(resultId)
      ? direct.downloadUrl(resultId)
      : server.downloadUrl(resultId),
    mode: () => direct.mode(),
  };
}
