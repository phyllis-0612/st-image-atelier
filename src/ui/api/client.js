import { API_ROOT } from '../../shared/constants.js';

export class ApiError extends Error {
  constructor(error, status) {
    super(error?.message || '服务端请求失败');
    this.code = error?.code || 'SERVER_PLUGIN_UNAVAILABLE';
    this.retryable = Boolean(error?.retryable);
    this.details = error?.details;
    this.status = status;
  }
}

export function createApiClient(compat) {
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
    updatePreset: patch => request('/presets/default', { method: 'PATCH', body: json(patch) }),
    clearSecret: () => request('/presets/default/clear-secret', { method: 'POST', body: '{}' }),
    listModels: () => request('/presets/default/models', { method: 'POST', body: '{}' }),
    testPreset: () => request('/presets/default/test', { method: 'POST', body: '{}' }),
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
