import { createGenerationNotifications } from './generation-notifications.js';
import { ACTIVE_STATUSES, upsertAttempt } from './generation-state.js';

export function createGenerationRunner({ api, compat, store, uuid, runGalleryCleanup = () => {}, pollIntervalMs = 900 }) {
  const running = new Map();
  function hasActive(tagId) {
    return Boolean(running.get(tagId)?.size)
      || Boolean(store.state.tagStates.get(tagId)?.attempts?.some(attempt => ACTIVE_STATUSES.has(attempt.status)));
  }

  async function waitForAttempt(attemptId, tagId, onProgress) {
    for (;;) {
      const attempt = await api.attempt(attemptId);
      onProgress?.(attempt);
      const current = store.state.tagStates.get(tagId) || { tagId, attempts: [], results: [] };
      store.setTag(tagId, upsertAttempt(current, attempt));
      if (['succeeded', 'failed', 'interrupted', 'cancelled'].includes(attempt.status)) {
        await refreshTag(tagId);
        return attempt;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  async function refreshTag(tagId) {
    const [resolved] = await api.resolveTags([tagId]);
    const current = store.state.tagStates.get(tagId);
    const ids = new Set(resolved.attempts?.map(attempt => attempt.attemptId));
    const missing = (current?.attempts || []).filter(attempt =>
      running.get(tagId)?.has(attempt.attemptId) && !ids.has(attempt.attemptId));
    const next = { ...resolved, attempts: [...missing, ...(resolved.attempts || [])] };
    store.setTag(tagId, next);
    return next;
  }

  async function generate(tag, mode, overrides = {}) {
    if (mode === 'auto' && hasActive(tag.tagId)) return;
    const parallel = hasActive(tag.tagId);
    const notifications = createGenerationNotifications(compat.notify);
    const attemptId = mode === 'auto' ? `auto:${tag.tagId}` : uuid();
    const pending = running.get(tag.tagId) || new Set();
    pending.add(attemptId);
    running.set(tag.tagId, pending);
    const provider = store.state.settings.generationProvider || 'openai';
    const prompt = Object.hasOwn(overrides, 'prompt') ? String(overrides.prompt || '') : tag.prompt;
    const optimisticAttempt = {
      attemptId,
      tagId: tag.tagId,
      requestMode: mode,
      parallel,
      provider,
      model: provider === 'novelai'
        ? (store.state.novelAi?.model || '')
        : (store.state.preset?.selectedModel || ''),
      status: 'generating',
      promptSnapshot: prompt,
      createdAt: new Date().toISOString(),
    };
    const current = store.state.tagStates.get(tag.tagId) || { tagId: tag.tagId, attempts: [], results: [] };
    store.setTag(tag.tagId, { ...current, attempts: [optimisticAttempt, ...(current.attempts || [])] });
    try {
      const attempt = await api.generate({
        tagId: tag.tagId,
        attemptId,
        requestMode: mode,
        parallel,
        provider,
        presetId: store.state.preset?.id || 'default',
        artistPresetId: store.state.artistPreset?.id || 'default',
        prompt,
        ...(Object.hasOwn(overrides, 'negativePromptOverride')
          ? { negativePromptOverride: overrides.negativePromptOverride } : {}),
        chatId: tag.chatId || compat.currentChatId(),
        messageUuid: tag.messageUuid,
        tagOrdinal: tag.ordinal,
        parameters: {
          ratio: tag.ratio,
          quality: tag.quality,
          count: tag.count,
        },
        onProgress: progressAttempt => {
          notifications.progress(progressAttempt);
          const latest = store.state.tagStates.get(tag.tagId) || current;
          store.setTag(tag.tagId, upsertAttempt(latest, progressAttempt));
        },
      });
      if (['succeeded', 'failed', 'interrupted', 'cancelled'].includes(attempt.status)) {
        if (attempt.status === 'failed' || attempt.status === 'interrupted') {
          notifications.failed(attempt, attempt.retryCount);
        }
        await refreshTag(tag.tagId);
        if (attempt.status === 'succeeded') void runGalleryCleanup();
        return attempt;
      }
      const completed = await waitForAttempt(attempt.attemptId, tag.tagId, notifications.progress);
      if (completed.status === 'failed' || completed.status === 'interrupted') {
        notifications.failed(completed, completed.retryCount);
      }
      if (completed.status === 'succeeded') void runGalleryCleanup();
      return completed;
    } catch (error) {
      try {
        await refreshTag(tag.tagId);
      } catch {
        // Keep the local failure card below when persistence could not be restored.
      }
      optimisticAttempt.status = 'failed';
      optimisticAttempt.errorCode = error.code;
      optimisticAttempt.errorMessage = error.message;
      const latest = store.state.tagStates.get(tag.tagId) || current;
      notifications.failed(error, error.autoRetryCount ?? latest.attempts?.find(item => item.attemptId === attemptId)?.retryCount);
      const persisted = latest.attempts?.find(item => item.attemptId === attemptId);
      if (!persisted || ['queued', 'generating', 'downloading', 'saving'].includes(persisted.status)) {
        store.setTag(tag.tagId, upsertAttempt(latest, optimisticAttempt));
      }
      console.warn('[画笺] 生图失败', error);
      return store.state.tagStates.get(tag.tagId)?.attempts?.find(item => item.attemptId === attemptId) || optimisticAttempt;
    } finally {
      const pending = running.get(tag.tagId);
      pending?.delete(attemptId);
      if (!pending?.size) running.delete(tag.tagId);
    }
  }

  return { generate, refreshTag, hasActive };
}
