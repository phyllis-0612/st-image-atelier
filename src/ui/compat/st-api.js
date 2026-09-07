export function createStCompat(dependencies) {
  const {
    getContext,
    eventSource,
    eventTypes,
    saveChatConditional,
    getRequestHeaders,
  } = dependencies;

  function context() {
    return typeof getContext === 'function'
      ? getContext()
      : globalThis.SillyTavern?.getContext?.();
  }

  function chat() {
    return context()?.chat || [];
  }

  function currentChatId() {
    const value = context()?.chatId
      ?? context()?.getCurrentChatId?.()
      ?? context()?.characterId
      ?? context()?.groupId;
    return value == null ? '' : String(value);
  }

  async function save() {
    if (typeof saveChatConditional === 'function') return saveChatConditional();
    const current = context();
    if (typeof current?.saveChat === 'function') return current.saveChat();
    if (typeof current?.saveMetadata === 'function') return current.saveMetadata();
    throw new Error('当前 SillyTavern 未提供聊天保存方法');
  }

  function headers({ json = true } = {}) {
    if (typeof getRequestHeaders === 'function') {
      return getRequestHeaders({ omitContentType: !json });
    }
    const token = context()?.token || globalThis.SillyTavern?.token;
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-CSRF-Token': token } : {}),
    };
  }

  function event(...names) {
    for (const name of names) {
      if (eventTypes?.[name]) return eventTypes[name];
    }
    return null;
  }

  function on(names, handler) {
    const selected = [...new Set(names.map(name => eventTypes?.[name]).filter(Boolean))];
    if (eventSource?.on) {
      for (const eventName of selected) eventSource.on(eventName, handler);
    }
    return selected;
  }

  function messageElement(messageId) {
    return document.querySelector(`#chat .mes[mesid="${CSS.escape(String(messageId))}"]`);
  }

  return {
    context,
    chat,
    currentChatId,
    save,
    headers,
    event,
    on,
    messageElement,
  };
}
