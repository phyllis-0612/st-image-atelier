'use strict';

const adapter = require('../adapters/openai-images');
const { ServiceRegistry } = require('../services/registry');
const { publicError, AppError } = require('../utils/errors');

function ok(response, data, status = 200) {
  return response.status(status).json({ ok: true, data });
}

function fail(response, error) {
  const exposed = publicError(error);
  const status = error instanceof AppError ? error.status : 500;
  return response.status(status).json({ ok: false, error: exposed });
}

function asyncRoute(handler) {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      fail(response, error);
    }
  };
}

function registerRoutes(router, registry = new ServiceRegistry()) {
  router.get('/health', asyncRoute(async (request, response) => {
    await registry.get(request);
    ok(response, {
      id: 'st-image-atelier',
      version: '1.5.0',
      status: 'ready',
      schemaVersion: 1,
    });
  }));

  router.get('/settings', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    ok(response, await services.preset.getSettings());
  }));

  router.patch('/settings', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    ok(response, await services.preset.updateSettings(request.body || {}));
  }));

  router.get('/presets', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    ok(response, await services.preset.list());
  }));

  const updatePreset = asyncRoute(async (request, response) => {
    if (request.params?.presetId && request.params.presetId !== 'default') {
      throw new AppError('NOT_FOUND', '第一期仅支持默认预设', 404);
    }
    const services = await registry.get(request);
    ok(response, await services.preset.update(request.body || {}));
  });
  router.post('/presets', updatePreset);
  router.patch('/presets/:presetId', updatePreset);

  router.post('/presets/:presetId/clear-secret', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    await services.preset.clearSecret();
    ok(response, { cleared: true });
  }));

  const modelsHandler = asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    const preset = await services.preset.get();
    const apiKey = await services.preset.getSecret();
    const settings = await services.preset.getSettings();
    const models = await adapter.listModels({ preset, apiKey, settings });
    const updated = await services.preset.update({
      cachedModels: models,
      modelsFetchedAt: new Date().toISOString(),
    });
    ok(response, { models, preset: updated });
  });
  router.post('/presets/:presetId/models', modelsHandler);
  router.post('/presets/:presetId/test', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    const preset = await services.preset.get();
    const apiKey = await services.preset.getSecret();
    const settings = await services.preset.getSettings();
    const models = await adapter.listModels({ preset, apiKey, settings });
    ok(response, { connected: true, modelCount: models.length });
  }));

  router.post('/tags/resolve', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    const tagIds = Array.isArray(request.body?.tagIds) ? request.body.tagIds.slice(0, 100) : [];
    ok(response, await services.generation.resolveTags(tagIds));
  }));

  router.post('/generate', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    ok(response, await services.generation.generate(request.body || {}), 202);
  }));

  router.get('/attempts/:attemptId', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    const attempt = services.metadata.getAttempt(request.params.attemptId);
    if (!attempt) throw new AppError('NOT_FOUND', 'attempt 不存在', 404);
    ok(response, attempt);
  }));

  router.post('/attempts/:attemptId/cancel', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    ok(response, await services.generation.cancel(request.params.attemptId));
  }));

  router.get('/gallery', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    ok(response, services.gallery.list({
      cursor: request.query?.cursor,
      limit: Number(request.query?.limit) || 30,
    }));
  }));

  router.post('/gallery/cleanup', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    const settings = await services.preset.getSettings();
    ok(response, await services.gallery.cleanup(settings));
  }));

  router.get('/gallery/:resultId/file', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    services.gallery.stream(request.params.resultId, response, false);
  }));

  router.get('/gallery/:resultId/download', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    services.gallery.stream(request.params.resultId, response, true);
  }));

  router.delete('/gallery/:resultId', asyncRoute(async (request, response) => {
    const services = await registry.get(request);
    ok(response, await services.gallery.delete(request.params.resultId));
  }));

  return registry;
}

module.exports = { registerRoutes, ok, fail };
