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
});
const activeTags = new Set();

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

async function generate(tag, mode) {
  if (activeTags.has(tag.tagId)) return;
  activeTags.add(tag.tagId);
  const attemptId = mode === 'auto' ? `auto:${tag.tagId}` : uuid();
  const provider = store.state.settings.generationProvider || 'openai';
  const optimisticAttempt = {
    attemptId,
    tagId: tag.tagId,
    requestMode: mode,
    provider,
    model: provider === 'novelai'
      ? (store.state.novelAi?.model || '')
      : (store.state.preset?.selectedModel || ''),
    status: 'generating',
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
      prompt: tag.prompt,
      chatId: tag.chatId || compat.currentChatId(),
      messageUuid: tag.messageUuid,
      tagOrdinal: tag.ordinal,
      parameters: {
        ratio: tag.ratio,
        quality: tag.quality,
        count: tag.count,
      },
    });
    if (['succeeded', 'failed', 'interrupted', 'cancelled'].includes(attempt.status)) {
      await refreshTag(tag.tagId);
      return attempt;
    }
    return await waitForAttempt(attempt.attemptId, tag.tagId);
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
const actions = {
  generate,
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
};
const renderer = createMessageRenderer({ compat, api, store, actions });
const events = createMessageEvents({ compat, api, store, renderer, autoQueue });

function installToolButton() {
  installToolMenuEntry({
    root: document,
    onOpen: () => panel.show(),
  });
}

function initialize() {
  panel = createToolPanel({ api, store });
  installToolButton();
  events.bind();
  void events.hydrate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
  initialize();
}
