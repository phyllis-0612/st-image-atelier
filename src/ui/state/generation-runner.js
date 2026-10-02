import { createGenerationNotifications } from './generation-notifications.js';
import { ACTIVE_STATUSES, upsertAttempt } from './generation-state.js';
import { normalizeBackupSettings } from '../../shared/backup-generation.js';

export function createGenerationRunner({ api, compat, store, uuid, runGalleryCleanup = () => {}, pollIntervalMs = 900,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
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
    const provider = overrides.provider || store.state.settings.generationProvider || 'openai';
    const preset = overrides.preset || store.state.preset;
    const presetId = overrides.presetId || preset?.id || 'default';
    const backup = normalizeBackupSettings(store.state.settings);
    const useBackup = backup.enableBackupPreset && provider === 'openai'
      && api.mode?.() === 'direct' && backup.backupPresetId && backup.backupPresetId !== presetId
      && !overrides.backupForAttemptId;
    let settled = false;
    let backupTimer;
    const prompt = Object.hasOwn(overrides, 'prompt') ? String(overrides.prompt || '') : tag.prompt;
    const optimisticAttempt = {
      attemptId,
      tagId: tag.tagId,
      requestMode: mode,
      parallel,
      backupForAttemptId: overrides.backupForAttemptId || null,
      provider,
      presetId,
      presetNameSnapshot: preset?.name || '',
      model: provider === 'novelai'
        ? (store.state.novelAi?.model || '')
        : (preset?.selectedModel || ''),
      status: 'generating',
      promptSnapshot: prompt,
      createdAt: new Date().toISOString(),
    };
    const current = store.state.tagStates.get(tag.tagId) || { tagId: tag.tagId, attempts: [], results: [] };
    store.setTag(tag.tagId, { ...current, attempts: [optimisticAttempt, ...(current.attempts || [])] });
    function backupAllowed() {
      return !settled && store.state.settings.enableBackupPreset === true
        && api.mode?.() === 'direct' && running.get(tag.tagId)?.has(attemptId);
    }
    async function launchBackup() {
      if (!backupAllowed()) return;
      const main = await api.attempt(attemptId);
      if (!backupAllowed() || !['queued', 'generating'].includes(main.status)) return;
      const { items = [] } = await api.getPresets();
      if (!backupAllowed()) return;
      const selected = items.find(item => item.id === backup.backupPresetId);
      if (!selected?.baseUrl || !selected?.selectedModel || !selected?.hasApiKey) {
        compat.notify?.('warning', '备用预设已删除或尚未配置地址、模型和 Key，本次未启动备用生成。', '画笺 · 备用生成未启动');
        return;
      }
      const latest = await api.attempt(attemptId);
      if (!backupAllowed() || !['queued', 'generating'].includes(latest.status)) return;
      compat.notify?.('warning', `主请求已等待 ${backup.backupWaitSeconds} 秒，正在用“${selected.name}”并行重 roll；原请求继续等待，两边的图片都会保存。`, '画笺 · 启用备用预设');
      void generate({ ...tag }, 'manual', {
        ...overrides, prompt, provider: 'openai', presetId: selected.id, preset: selected,
        backupForAttemptId: attemptId, keepWaitingOnTimeout: true,
      });
    }
    try {
      if (useBackup) {
        backupTimer = setTimer(() => {
          void launchBackup().catch(error => {
            if (backupAllowed()) compat.notify?.('warning', `备用生成未启动：${error.message}`, '画笺');
          });
        }, backup.backupWaitSeconds * 1000);
      }
      const attempt = await api.generate({
        tagId: tag.tagId,
        attemptId,
        requestMode: mode,
        parallel,
        backupForAttemptId: overrides.backupForAttemptId || null,
        ...(useBackup || overrides.keepWaitingOnTimeout ? { keepWaitingOnTimeout: true } : {}),
        provider,
        presetId,
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
        settled = true;
        if (attempt.status === 'failed' || attempt.status === 'interrupted') {
          notifications.failed(attempt, attempt.retryCount);
        }
        await refreshTag(tag.tagId);
        if (attempt.status === 'succeeded') void runGalleryCleanup();
        return attempt;
      }
      const completed = await waitForAttempt(attempt.attemptId, tag.tagId, notifications.progress);
      settled = true;
      if (completed.status === 'failed' || completed.status === 'interrupted') {
        notifications.failed(completed, completed.retryCount);
      }
      if (completed.status === 'succeeded') void runGalleryCleanup();
      return completed;
    } catch (error) {
      settled = true;
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
      settled = true;
      if (backupTimer !== undefined) clearTimer(backupTimer);
      const pending = running.get(tag.tagId);
      pending?.delete(attemptId);
      if (!pending?.size) running.delete(tag.tagId);
    }
  }

  return { generate, refreshTag, hasActive };
}
