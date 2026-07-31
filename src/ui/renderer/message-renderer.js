import { createCard } from './card.js';

export function findDrawMarkupSpans(text) {
  const pattern = /<draw\b[^>]*>[\s\S]*?<\/draw\s*>/gi;
  const spans = [];
  let match;
  while ((match = pattern.exec(String(text || ''))) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length, raw: match[0] });
  }
  return spans;
}

function visibleTextNodes(container) {
  const nodes = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.data || node.parentElement?.closest('.stia-card, script, style')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function boundaryAt(nodes, absoluteOffset) {
  let traversed = 0;
  for (const node of nodes) {
    const next = traversed + node.data.length;
    if (absoluteOffset <= next) {
      return { node, offset: Math.max(0, absoluteOffset - traversed) };
    }
    traversed = next;
  }
  const last = nodes.at(-1);
  return last ? { node: last, offset: last.data.length } : null;
}

function textRanges(container) {
  const nodes = visibleTextNodes(container);
  const combined = nodes.map(node => node.data).join('');
  return findDrawMarkupSpans(combined).map(span => {
    const start = boundaryAt(nodes, span.start);
    const end = boundaryAt(nodes, span.end);
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return { range, raw: span.raw };
  }).filter(Boolean);
}

function comparableText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function replaceRange(range, replacement, raw) {
  const common = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  const paragraph = common?.closest?.('p');
  if (paragraph
    && !paragraph.closest('.stia-card')
    && comparableText(paragraph.textContent) === comparableText(raw || range.toString())) {
    paragraph.replaceWith(replacement);
    return;
  }
  range.deleteContents();
  range.insertNode(replacement);
}

export function createMessageRenderer(dependencies) {
  const { compat, api, store, actions } = dependencies;
  const cards = new Map();

  function stateFor(tagId) {
    return store.state.tagStates.get(tagId);
  }

  function makeCard(tag) {
    const card = createCard({
      tag,
      api,
      getState: stateFor,
      onGenerate: actions.generate,
      onOpenGallery: actions.openGallery,
      onCancel: actions.cancel,
    });
    cards.set(tag.tagId, card);
    card.render();
    return card;
  }

  function mount(messageId, tags) {
    const message = compat.messageElement(messageId);
    const container = message?.querySelector('.mes_text');
    if (!container) return { mounted: 0, fallback: 0 };

    const missing = tags
      .map((tag, index) => ({ tag, index }))
      .filter(({ tag }) =>
        !container.querySelector(`.stia-card[data-tag-id="${CSS.escape(tag.tagId)}"]`));
    if (!missing.length) return { mounted: 0, fallback: 0 };

    const drawElements = [...container.querySelectorAll('draw')]
      .filter(element => !element.closest('.stia-card'));
    let unresolved = missing;
    let mounted = 0;
    if (drawElements.length) {
      const anchored = unresolved.slice(0, drawElements.length);
      for (const [{ tag }, anchor] of anchored.map((item, index) => [item, drawElements[index]])) {
        if (!anchor) continue;
        const card = makeCard(tag);
        anchor.replaceWith(card.root);
        mounted += 1;
      }
      unresolved = unresolved.slice(anchored.length);
      if (!unresolved.length) return { mounted, fallback: 0 };
    }

    const ranges = textRanges(container);
    const replacements = unresolved
      .map(({ tag }, index) => ({
        tag,
        range: ranges[index]?.range,
        raw: ranges[index]?.raw,
      }))
      .filter(item => item.range);
    for (const { tag, range, raw } of replacements.reverse()) {
      const card = makeCard(tag);
      replaceRange(range, card.root, raw);
    }

    mounted += replacements.length;
    const mountedIds = new Set(replacements.map(item => item.tag.tagId));
    unresolved = unresolved.filter(({ tag }) => !mountedIds.has(tag.tagId)
      && !container.querySelector(`.stia-card[data-tag-id="${CSS.escape(tag.tagId)}"]`));
    if (!unresolved.length) return { mounted, fallback: 0 };

    let fallback = container.querySelector(':scope > .stia-card-list');
    if (!fallback) {
      fallback = document.createElement('div');
      fallback.className = 'stia-card-list';
      container.append(fallback);
    }
    for (const { tag } of unresolved) fallback.append(makeCard(tag).root);
    return { mounted, fallback: unresolved.length };
  }

  function renderTag(tagId) {
    cards.get(tagId)?.render();
  }

  store.subscribe(() => {
    for (const card of cards.values()) {
      if (card.root.isConnected) card.render();
    }
  });

  return { mount, renderTag };
}
