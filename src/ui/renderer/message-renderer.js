import { createCard } from './card.js';

export function createMessageRenderer(dependencies) {
  const { compat, api, store, actions } = dependencies;
  const cards = new Map();

  function stateFor(tagId) {
    return store.state.tagStates.get(tagId);
  }

  function mount(messageId, tags) {
    const message = compat.messageElement(messageId);
    const container = message?.querySelector('.mes_text');
    if (!container) return;

    const drawElements = [...container.querySelectorAll('draw')];
    let fallback = container.querySelector(':scope > .stia-card-list');
    if (!drawElements.length && !fallback) {
      fallback = document.createElement('div');
      fallback.className = 'stia-card-list';
      container.append(fallback);
    }

    tags.forEach((tag, index) => {
      const existing = container.querySelector(`.stia-card[data-tag-id="${CSS.escape(tag.tagId)}"]`);
      if (existing) return;
      const card = createCard({
        tag,
        api,
        getState: stateFor,
        onGenerate: actions.generate,
        onOpenGallery: actions.openGallery,
        onCancel: actions.cancel,
      });
      cards.set(tag.tagId, card);
      if (drawElements[index]) drawElements[index].replaceWith(card.root);
      else fallback?.append(card.root);
      card.render();
    });
  }

  function renderTag(tagId) {
    cards.get(tagId)?.render();
  }

  store.subscribe(() => {
    for (const card of cards.values()) card.render();
  });

  return { mount, renderTag };
}
