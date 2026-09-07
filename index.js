import {
  eventSource,
  event_types,
  getRequestHeaders,
  saveChatConditional,
  saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { accountStorage } from '../../../util/AccountStorage.js';
import { createStCompat } from './src/ui/compat/st-api.js';
import { createApiClient } from './src/ui/api/client.js';
import { createStore } from './src/ui/state/store.js';
import { createAutoQueue } from './src/ui/state/auto-queue.js';
import { createMessageRenderer } from './src/ui/renderer/message-renderer.js';
import { createMessageEvents } from './src/ui/events/message-events.js';
import { createToolPanel } from './src/ui/pages/settings/settings.js';
import { installToolMenuEntry } from './src/ui/menu/tool-menu.js';
import { applyThemeMode } from './src/ui/theme/theme.js';
import { removeDrawTagFromMessage } from './src/ui/state/tag-removal.js';
import { createPromptOverrideDialog } from './src/ui/pages/prompt-override/prompt-override.js';

const compat = createStCompat({
  getContext,
  eventSource,
  eventTypes: event_types,
  saveChatConditional,
  getRequestHeaders,
});
const api = createApiClient({
  compat,
  extensionSettings: extension_settings,
  saveSettingsDebounced,
  keyStorage: accountStorage,
});
const store = createStore();
store.subscribe(state => {
  document.documentElement.classList.toggle('stia-disabled', !state.settings.enabled);
  applyThemeMode(state.settings.themeMode);
});
applyThemeMode(store.state.settings.themeMode);
const activeTags = new Set();
const GALLERY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

async function runGalleryCleanup() {
  try {
    return await api.cleanupGallery();
  } catch (error) {
    console.warn('[Image Atelier] 画廊自动清理检查失败', error);
    return null;
  }
}

function uuid() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12)}`;
}

async function waitForAttempt(attemptId, tagId) {
  for (;;) {
    const attempt = await api.attempt(attemptId);
    const current = store.state.tagStates.get(tagId) || { tagId, attempts: [], results: [] };
    store.setTag(tagId, { ...current, attempts: [attempt, ...(current.attempts || []).filter(item => item.attemptId !== attemptId)] });
    if (['succeeded', 'failed', 'interrupted', 'cancelled'].includes(attempt.status)) {
      const [resolved] = await api.resolveTags([tagId]);
      store.setTag(tagId, resolved);
      return attempt;
    }
    await new Promise(resolve => setTimeout(resolve, 900));
  }
}

async function refreshTag(tagId) {
  const [resolved] = await api.resolveTags([tagId]);
  store.setTag(tagId, resolved);
  return resolved;
}

async function generate(tag, mode, overrides = {}) {
  if (activeTags.has(tag.tagId)) return;
  activeTags.add(tag.tagId);
  const attemptId = mode === 'auto' ? `auto:${tag.tagId}` : uuid();
  const provider = store.state.settings.generationProvider || 'openai';
  const prompt = Object.hasOwn(overrides, 'prompt') ? String(overrides.prompt || '') : tag.prompt;
  const optimisticAttempt = {
    attemptId,
    tagId: tag.tagId,
    requestMode: mode,
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
        const latest = store.state.tagStates.get(tag.tagId) || current;
        store.setTag(tag.tagId, {
          ...latest,
          attempts: [
            progressAttempt,
            ...(latest.attempts || []).filter(item => item.attemptId !== progressAttempt.attemptId),
          ],
        });
      },
    });
    if (['succeeded', 'failed', 'interrupted', 'cancelled'].includes(attempt.status)) {
      await refreshTag(tag.tagId);
      if (attempt.status === 'succeeded') void runGalleryCleanup();
      return attempt;
    }
    const completed = await waitForAttempt(attempt.attemptId, tag.tagId);
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
    if (!(latest.attempts || []).some(item => item.attemptId === attemptId)) {
      store.setTag(tag.tagId, {
        ...latest,
        attempts: [optimisticAttempt, ...(latest.attempts || [])],
      });
    }
    throw error;
  } finally {
    activeTags.delete(tag.tagId);
  }
}

const autoQueue = createAutoQueue(generate);
let panel;
let promptOverrideDialog;
const actions = {
  generate,
  adjustRegenerate: async (tag, context = {}) => {
    const provider = store.state.settings.generationProvider || 'openai';
    const value = await promptOverrideDialog.open({
      prompt: context.prompt || tag.prompt,
      negativePrompt: provider === 'novelai'
        ? (context.negativePrompt || store.state.novelAi?.negativePrompt || '')
        : '',
      provider,
    });
    if (!value) return null;
    return generate(tag, 'manual', {
      prompt: value.prompt,
      ...(provider === 'novelai' ? { negativePromptOverride: value.negativePrompt } : {}),
    });
  },
  cancel: async attemptId => {
    await api.cancel(attemptId);
    const entry = [...store.state.tagStates.values()]
      .find(value => value.attempts?.some(attempt => attempt.attemptId === attemptId));
    const tagId = entry?.tagId;
    if (tagId) {
      await refreshTag(tagId);
    }
  },
  openGallery: () => panel.show('gallery'),
  remove: async tag => removeTag(tag),
};
const renderer = createMessageRenderer({ compat, api, store, actions });
const events = createMessageEvents({ compat, api, store, renderer, autoQueue });

/* 一键删除：卡片 + 消息里的 <draw> 注入词 + 标签元数据一起清掉，落盘后不留痕迹。 */
async function removeTag(tag) {
  if (activeTags.has(tag.tagId)) return false;
  const chat = compat.chat();
  const messageId = chat.findIndex(message => {
    const metadata = message?.extra?.stImageAtelier;
    if (!metadata) return false;
    if (tag.messageUuid && metadata.messageUuid === tag.messageUuid) return true;
    return (metadata.tags || []).some(item => item?.tagId === tag.tagId);
  });
  if (messageId < 0) {
    renderer.removeCard(tag.tagId);
    store.removeTag(tag.tagId);
    return false;
  }
  const { changed } = removeDrawTagFromMessage(chat[messageId], tag.tagId);
  renderer.removeCard(tag.tagId);
  store.removeTag(tag.tagId);
  if (!changed) return false;
  try {
    await compat.save();
  } catch (error) {
    console.error('[Image Atelier] 删除生图标签后无法保存聊天', error);
  }
  await events.processMessage(messageId, { live: false });
  return true;
}

function installToolButton() {
  installToolMenuEntry({
    root: document,
    onOpen: () => panel.show(),
  });
}

function initialize() {
  panel = createToolPanel({ api, store });
  promptOverrideDialog = createPromptOverrideDialog();
  installToolButton();
  events.bind();
  void events.hydrate();
  void runGalleryCleanup();
  setInterval(() => void runGalleryCleanup(), GALLERY_CLEANUP_INTERVAL_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
  initialize();
}
