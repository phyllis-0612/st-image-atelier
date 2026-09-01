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

function normalizeWithOffsets(value) {
  const text = String(value || '');
  let normalized = '';
  const starts = [];
  const ends = [];
  let pendingWhitespace = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (/\s/.test(character)) {
      if (normalized && !normalized.endsWith(' ')) {
        pendingWhitespace ??= index;
      }
      continue;
    }
    if (pendingWhitespace != null) {
      normalized += ' ';
      starts.push(pendingWhitespace);
      ends.push(index);
      pendingWhitespace = null;
    }
    normalized += character;
    starts.push(index);
    ends.push(index + 1);
  }
  return { normalized, starts, ends };
}

export function findNormalizedTextSpan(text, needle, from = 0) {
  const source = normalizeWithOffsets(text);
  const target = normalizeWithOffsets(needle).normalized;
  if (!target) return null;
  const normalizedStart = source.normalized.indexOf(target, Math.max(0, from));
  if (normalizedStart < 0) return null;
  const normalizedEnd = normalizedStart + target.length;
  return {
    start: source.starts[normalizedStart],
    end: source.ends[normalizedEnd - 1],
    normalizedStart,
    normalizedEnd,
  };
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

function boundaryAt(nodes, absoluteOffset, side = 'start') {
  let traversed = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const next = traversed + node.data.length;
    const isSharedBoundary = absoluteOffset === next && index < nodes.length - 1;
    if (absoluteOffset < next || (absoluteOffset === next && (side === 'end' || !isSharedBoundary))) {
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
    const start = boundaryAt(nodes, span.start, 'start');
    const end = boundaryAt(nodes, span.end, 'end');
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return { range, raw: span.raw };
  }).filter(Boolean);
}

function promptRanges(container, tags) {
  const nodes = visibleTextNodes(container);
  const combined = nodes.map(node => node.data).join('');
  const normalized = normalizeWithOffsets(combined);
  let cursor = 0;
  return tags.map(tag => {
    const target = normalizeWithOffsets(tag.prompt).normalized;
    if (!target) return null;
    let normalizedStart = normalized.normalized.indexOf(target, cursor);
    if (normalizedStart < 0) normalizedStart = normalized.normalized.indexOf(target);
    if (normalizedStart < 0) return null;
    const normalizedEnd = normalizedStart + target.length;
    cursor = normalizedEnd;
    const startOffset = normalized.starts[normalizedStart];
    const endOffset = normalized.ends[normalizedEnd - 1];
    const start = boundaryAt(nodes, startOffset, 'start');
    const end = boundaryAt(nodes, endOffset, 'end');
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return { range, raw: tag.prompt };
  });
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

    const promptMatches = promptRanges(container, unresolved.map(item => item.tag));
    const promptReplacements = unresolved
      .map(({ tag }, index) => ({
        tag,
        range: promptMatches[index]?.range,
        raw: promptMatches[index]?.raw,
      }))
      .filter(item => item.range);
    for (const { tag, range, raw } of promptReplacements.reverse()) {
      const card = makeCard(tag);
      replaceRange(range, card.root, raw);
    }
    mounted += promptReplacements.length;
    const promptMountedIds = new Set(promptReplacements.map(item => item.tag.tagId));
    unresolved = unresolved.filter(({ tag }) => !promptMountedIds.has(tag.tagId)
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
