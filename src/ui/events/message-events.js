import { parseDrawTags, shouldProcessMessage } from '../parser/draw-parser.js';
import { reconcileTagMetadata } from '../state/tag-identity.js';

const DOM_SETTLE_MS = 140;
const SOURCE_SCAN_INTERVAL_MS = 1_500;

export function hasChangedDrawSource(message, previousSource) {
  return shouldProcessMessage(message)
    && message.mes !== previousSource
    && /<draw\b/i.test(message.mes);
}

export function createMessageEvents({ compat, api, store, renderer, autoQueue }) {
  const sourceCache = new Map();
  const scheduled = new Map();
  let observer = null;
  let observedChat = null;
  let pollTimer = null;
  let hydrated = false;
  let cachedChatId = '';

  async function processMessage(messageId, { live = false, generationType = '' } = {}) {
    const message = compat.chat()[Number(messageId)];
    if (!shouldProcessMessage(message)) return;
    sourceCache.set(String(messageId), message.mes);
    const parsed = parseDrawTags(message.mes);
    if (!parsed.length) return;

    const { metadata, changed } = reconcileTagMetadata(message, parsed);
    if (changed) {
      try {
        await compat.save();
      } catch (error) {
        console.error('[Image Atelier] 无法保存标签元数据', error);
      }
    }

    const tags = metadata.tags.map((tag, index) => ({
      ...parsed[index],
      ...tag,
      messageUuid: metadata.messageUuid,
      chatId: compat.currentChatId(),
    }));
    renderer.mount(messageId, tags);
    try {
      const resolved = await api.resolveTags(tags.map(tag => tag.tagId));
      for (const value of resolved) store.setTag(value.tagId, value);
    } catch (error) {
      store.set({ serviceError: error });
    }
    renderer.mount(messageId, tags);

    const eligibleLiveMessage = store.state.settings.enabled
      && live
      && generationType !== 'first_message'
      && store.state.settings.autoGenerate;
    if (eligibleLiveMessage) {
      for (const tag of tags.slice(0, 3)) {
        const current = store.state.tagStates.get(tag.tagId);
        if (!current?.tag?.autoAttempted && !current?.tag?.autoSuppressed && !tag.autoSuppressed) {
          autoQueue.enqueue(tag);
        }
      }
    }
  }

  async function hydrate() {
    hydrated = false;
    cachedChatId = compat.currentChatId();
    sourceCache.clear();
    const chat = compat.chat();
    const ids = chat.map((_, index) => index);
    for (const messageId of ids) {
      await processMessage(messageId, { live: false });
    }
    hydrated = true;
  }

  function scheduleMessage(messageId, options = {}) {
    const id = String(messageId ?? '');
    if (!/^\d+$/.test(id)) return;
    const previous = scheduled.get(id);
    clearTimeout(previous?.timer);
    const mergedOptions = {
      ...previous?.options,
      ...options,
      live: Boolean(previous?.options?.live || options.live),
    };
    const timer = setTimeout(() => {
      scheduled.delete(id);
      void processMessage(id, mergedOptions).catch(error => {
        console.error('[Image Atelier] 实时识别生图标签失败', error);
      });
    }, DOM_SETTLE_MS);
    scheduled.set(id, { timer, options: mergedOptions });
  }

  function messageIdFromNode(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return element?.closest?.('#chat .mes[mesid]')?.getAttribute('mesid') ?? null;
  }

  function observeChat() {
    const chatElement = document.querySelector('#chat');
    if (!chatElement || chatElement === observedChat) return;
    observer?.disconnect();
    observedChat = chatElement;
    observer = new MutationObserver(records => {
      const ids = new Set();
      for (const record of records) {
        const targetElement = record.target?.nodeType === Node.ELEMENT_NODE
          ? record.target
          : record.target?.parentElement;
        if (targetElement?.closest?.('.stia-card')) continue;
        const id = messageIdFromNode(record.target);
        if (id != null) ids.add(id);
        for (const node of record.addedNodes || []) {
          if (node.nodeType === Node.ELEMENT_NODE && node.matches?.('.stia-card, .stia-card-list')) {
            continue;
          }
          const addedId = messageIdFromNode(node);
          if (addedId != null) ids.add(addedId);
        }
      }
      for (const id of ids) scheduleMessage(id, { live: hydrated });
    });
    observer.observe(chatElement, { childList: true, characterData: true, subtree: true });
  }

  function scanChangedSources() {
    if (!hydrated) return;
    const chatId = compat.currentChatId();
    if (chatId !== cachedChatId) {
      cachedChatId = chatId;
      void hydrate();
      return;
    }
    compat.chat().forEach((message, messageId) => {
      if (!shouldProcessMessage(message)) return;
      const id = String(messageId);
      const previousSource = sourceCache.get(id);
      if (previousSource === message.mes) return;
      sourceCache.set(id, message.mes);
      if (hasChangedDrawSource(message, previousSource)) {
        scheduleMessage(id, { live: true });
      }
    });
  }

  function bind() {
    compat.on(['MESSAGE_RECEIVED'], (messageId, generationType) =>
      processMessage(messageId, { live: true, generationType }));
    compat.on(['CHARACTER_MESSAGE_RENDERED', 'MESSAGE_RENDERED'], messageId =>
      processMessage(messageId, { live: false }));
    /* 改写事件会赶在酒馆用 mes 重建这一层 DOM 之前到达。直接 processMessage 等于对着
       旧 DOM 干活：卡片还在、提示词还没回来，mount 判定无事可做直接退出；等重建真的发生，
       事件已经消耗掉了。改走 scheduleMessage，等 DOM_SETTLE_MS 落定后再处理，
       与 MutationObserver 走同一条路，并合并成一次。 */
    compat.on(['MESSAGE_UPDATED', 'MESSAGE_EDITED'], messageId =>
      scheduleMessage(messageId, { live: false }));
    compat.on(['CHAT_CHANGED'], () => {
      queueMicrotask(() => {
        observeChat();
        void hydrate();
      });
    });
    observeChat();
    if (!pollTimer) pollTimer = setInterval(scanChangedSources, SOURCE_SCAN_INTERVAL_MS);
  }

  return { processMessage, hydrate, bind };
}
