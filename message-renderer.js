import { createCard } from './card.js';
import { parseDrawTags } from '../parser/draw-parser.js';

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'HEADER', 'H1', 'H2', 'H3', 'H4',
  'H5', 'H6', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

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

export function buildVisibleTextSnapshot(container) {
  let text = '';
  const segments = [];

  const appendSeparator = () => {
    if (text && !/\s$/.test(text)) text += '\n';
  };

  const visit = node => {
    if (!node) return;
    if (node.nodeType === 3) {
      const value = String(node.data || '');
      if (!value) return;
      const start = text.length;
      text += value;
      segments.push({ node, start, end: text.length });
      return;
    }
    if (node.nodeType !== 1) return;
    const tagName = String(node.tagName || '').toUpperCase();
    if (node !== container
      && (tagName === 'SCRIPT' || tagName === 'STYLE' || node.classList?.contains('stia-card'))) {
      return;
    }
    if (tagName === 'BR') {
      appendSeparator();
      return;
    }
    const isBlock = node !== container && BLOCK_TAGS.has(tagName);
    if (isBlock) appendSeparator();
    for (const child of node.childNodes || []) visit(child);
    if (isBlock) appendSeparator();
  };

  visit(container);
  return { text, segments };
}

function boundaryAt(snapshot, absoluteOffset, side = 'start') {
  const { segments } = snapshot;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (absoluteOffset < segment.start || absoluteOffset > segment.end) continue;
    const next = segments[index + 1];
    const isSharedBoundary = absoluteOffset === segment.end && next?.start === absoluteOffset;
    if (absoluteOffset < segment.end
      || side === 'end'
      || !isSharedBoundary) {
      return {
        node: segment.node,
        offset: Math.max(0, Math.min(segment.node.data.length, absoluteOffset - segment.start)),
      };
    }
  }
  const last = segments.at(-1);
  return last ? { node: last.node, offset: last.node.data.length } : null;
}

function textRanges(container) {
  const snapshot = buildVisibleTextSnapshot(container);
  return findDrawMarkupSpans(snapshot.text).map(span => {
    const start = boundaryAt(snapshot, span.start, 'start');
    const end = boundaryAt(snapshot, span.end, 'end');
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return { range, raw: span.raw };
  }).filter(Boolean);
}

function promptRanges(container, tags) {
  const snapshot = buildVisibleTextSnapshot(container);
  const normalized = normalizeWithOffsets(snapshot.text);
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
    const start = boundaryAt(snapshot, startOffset, 'start');
    const end = boundaryAt(snapshot, endOffset, 'end');
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
    && comparableText(buildVisibleTextSnapshot(paragraph).text)
      === comparableText(raw || range.toString())) {
    paragraph.replaceWith(replacement);
    return;
  }
  range.deleteContents();
  range.insertNode(replacement);
}

function removeRange(range, raw) {
  const common = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  const paragraph = common?.closest?.('p');
  if (paragraph
    && !paragraph.closest('.stia-card')
    && comparableText(buildVisibleTextSnapshot(paragraph).text)
      === comparableText(raw || range.toString())) {
    paragraph.remove();
    return;
  }
  range.deleteContents();
}

function matchingTag(tags, prompt, used) {
  const comparablePrompt = comparableText(prompt);
  return tags.find(tag => !used.has(tag.tagId)
    && comparableText(tag.prompt) === comparablePrompt);
}

function cleanupExistingSources(container, tags) {
  const existing = tags.filter(tag =>
    container.querySelector(`.stia-card[data-tag-id="${CSS.escape(tag.tagId)}"]`));
  if (!existing.length) return;
  const used = new Set();

  for (const element of [...container.querySelectorAll('draw')]
    .filter(value => !value.closest('.stia-card'))) {
    const elementText = buildVisibleTextSnapshot(element).text;
    const tag = matchingTag(existing, elementText, used);
    if (!tag) continue;
    used.add(tag.tagId);
    const paragraph = element.closest('p');
    if (paragraph
      && comparableText(buildVisibleTextSnapshot(paragraph).text) === comparableText(elementText)) {
      paragraph.remove();
    } else {
      element.remove();
    }
  }

  const markupMatches = textRanges(container).map(item => {
    const parsed = parseDrawTags(item.raw, { warn: () => {} });
    const tag = matchingTag(existing, parsed[0]?.prompt || '', used);
    if (tag) used.add(tag.tagId);
    return { ...item, tag };
  }).filter(item => item.tag);
  for (const { range, raw } of markupMatches.reverse()) removeRange(range, raw);

  const remaining = existing.filter(tag => !used.has(tag.tagId));
  const promptMatches = promptRanges(container, remaining);
  const promptRemovals = remaining.map((tag, index) => ({
    tag,
    range: promptMatches[index]?.range,
    raw: promptMatches[index]?.raw,
  })).filter(item => item.range);
  for (const { range, raw } of promptRemovals.reverse()) removeRange(range, raw);
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

    const activeTagIds = new Set(tags.map(tag => tag.tagId));
    for (const card of [...container.querySelectorAll('.stia-card[data-tag-id]')]) {
      const tagId = card.getAttribute('data-tag-id');
      if (!tagId || activeTagIds.has(tagId)) continue;
      card.remove();
      cards.delete(tagId);
    }
    for (const list of [...container.querySelectorAll(':scope > .stia-card-list')]) {
      if (!list.querySelector('.stia-card')) list.remove();
    }
    cleanupExistingSources(container, tags);

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
