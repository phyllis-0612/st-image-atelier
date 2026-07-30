import { parseDrawTags, shouldProcessMessage } from '../parser/draw-parser.js';
import { reconcileTagMetadata } from '../state/tag-identity.js';

export function createMessageEvents({ compat, api, store, renderer, autoQueue }) {
  async function processMessage(messageId, { live = false, generationType = '' } = {}) {
    const message = compat.chat()[Number(messageId)];
    if (!shouldProcessMessage(message)) return;
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
    const chat = compat.chat();
    const ids = chat.map((_, index) => index);
    for (const messageId of ids) {
      await processMessage(messageId, { live: false });
    }
  }

  function bind() {
    compat.on(['MESSAGE_RECEIVED'], (messageId, generationType) =>
      processMessage(messageId, { live: true, generationType }));
    compat.on(['CHARACTER_MESSAGE_RENDERED', 'MESSAGE_RENDERED'], messageId =>
      processMessage(messageId, { live: false }));
    compat.on(['MESSAGE_UPDATED', 'MESSAGE_EDITED'], messageId =>
      processMessage(messageId, { live: false }));
    compat.on(['CHAT_CHANGED'], () => {
      queueMicrotask(() => hydrate());
    });
  }

  return { processMessage, hydrate, bind };
}
