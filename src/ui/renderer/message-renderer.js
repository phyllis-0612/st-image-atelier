import { createCard } from './card.js';
import { parseDrawTags } from '../parser/draw-parser.js';

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'HEADER', 'H1', 'H2', 'H3', 'H4',
  'H5', 'H6', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

/* 模糊定位的锚点长度与启用门槛（按压缩后的字符数计）。
   短提示词几乎总能精确命中，模糊匹配只给长模板兜底。 */
const FUZZY_ANCHOR_LENGTH = 24;
const FUZZY_MIN_LENGTH = 48;
const FUZZY_MIN_RATIO = 0.7;
const FUZZY_MAX_RATIO = 1.3;

/* 酒馆会把提示词当 Markdown 渲染：行首的 "1. " "- " "> " "# " 被转成列表、引用、标题，
   "*" "_" "`" 等强调符号被吃掉。比对时把这些语法字符从两侧一并去掉。 */
const MARKDOWN_LINE_PREFIX = /^[ \t]*(?:\d+[.)]|[-*+>#]+)[ \t]+/gm;
const MARKDOWN_RULE_LINE = /^[ \t]*(?:[-*_][ \t]*){3,}$/gm;
const MARKDOWN_INLINE_CHARS = new Set(['*', '_', '~', '`', '#', '>', '\\']);
const VISIBLE_MEDIA_SELECTOR = 'img, video, audio, iframe, canvas, svg, input, button, table';
const MEDIA_SELECTOR = `.stia-card, ${VISIBLE_MEDIA_SELECTOR}`;

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

/* 空白与 Markdown 语法无关的压缩键，并保留每个字符在原文中的偏移。
   - 所有空白全部去掉：`<br>`、块级换行、酒馆折叠的空格都不再要求对齐。
   - 行首列表 / 引用 / 标题标记和分隔线整行去掉。
   - 行内强调符号去掉。
   两侧（提示词原文与 DOM 文本）用同一把尺子量，转换是否发生都不影响比对。 */
export function squeezeWithOffsets(value) {
  const text = String(value || '');
  const skipped = new Uint8Array(text.length);
  for (const pattern of [MARKDOWN_LINE_PREFIX, MARKDOWN_RULE_LINE]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      for (let index = match.index; index < match.index + match[0].length; index += 1) {
        skipped[index] = 1;
      }
      if (!match[0].length) pattern.lastIndex += 1;
    }
  }
  let squeezed = '';
  const starts = [];
  const ends = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (skipped[index] || /\s/.test(character) || MARKDOWN_INLINE_CHARS.has(character)) continue;
    squeezed += character;
    starts.push(index);
    ends.push(index + 1);
  }
  return { text, squeezed, starts, ends };
}

function squeezedKey(value) {
  return squeezeWithOffsets(value).squeezed;
}

/* 头尾锚点定位：精确匹配失败时（中间被 Markdown 改掉了几个字符、宏被替换等），
   用提示词开头与结尾各一段去 DOM 里找，两端都命中且长度比例合理才算数。 */
export function fuzzyLocate(haystack, target, from = 0) {
  if (target.length < FUZZY_MIN_LENGTH) return null;
  const head = target.slice(0, FUZZY_ANCHOR_LENGTH);
  const tail = target.slice(-FUZZY_ANCHOR_LENGTH);
  const minLength = Math.floor(target.length * FUZZY_MIN_RATIO);
  const maxLength = Math.ceil(target.length * FUZZY_MAX_RATIO);
  let headStart = haystack.indexOf(head, from);
  while (headStart >= 0) {
    let tailStart = haystack.indexOf(tail, headStart + head.length);
    while (tailStart >= 0) {
      const end = tailStart + tail.length;
      const length = end - headStart;
      if (length > maxLength) break;
      if (length >= minLength) return { start: headStart, end };
      tailStart = haystack.indexOf(tail, tailStart + 1);
    }
    headStart = haystack.indexOf(head, headStart + 1);
  }
  return null;
}

export function locateSqueezed(haystack, target, { from = 0, wrap = true } = {}) {
  if (!target) return null;
  const exactFrom = haystack.indexOf(target, from);
  if (exactFrom >= 0) return { start: exactFrom, end: exactFrom + target.length };
  if (wrap && from > 0) {
    const exact = haystack.indexOf(target);
    if (exact >= 0) return { start: exact, end: exact + target.length };
  }
  return fuzzyLocate(haystack, target, from) || (wrap && from > 0 ? fuzzyLocate(haystack, target, 0) : null);
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
      && (tagName === 'SCRIPT' || tagName === 'STYLE' || tagName === 'TEXTAREA'
        || node.classList?.contains('stia-card'))) {
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

function rangeBetween(snapshot, startOffset, endOffset) {
  const start = boundaryAt(snapshot, startOffset, 'start');
  const end = boundaryAt(snapshot, endOffset, 'end');
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/* 一次快照 + 一次压缩，供同一轮内的多次定位共用。DOM 改动之后必须重新创建。 */
function createLocator(container) {
  const snapshot = buildVisibleTextSnapshot(container);
  const source = squeezeWithOffsets(snapshot.text);
  return {
    cursorAfter(node) {
      const segment = snapshot.segments.find(item =>
        Boolean(node.compareDocumentPosition(item.node) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (!segment) return source.squeezed.length;
      let index = 0;
      while (index < source.starts.length && source.starts[index] < segment.start) index += 1;
      return index;
    },
    find(target, options = {}) {
      const span = locateSqueezed(source.squeezed, target, options);
      if (!span) return null;
      const range = rangeBetween(snapshot, source.starts[span.start], source.ends[span.end - 1]);
      return range ? { range, start: span.start, end: span.end } : null;
    },
  };
}

function textRanges(container) {
  const snapshot = buildVisibleTextSnapshot(container);
  return findDrawMarkupSpans(snapshot.text).map(span => {
    const range = rangeBetween(snapshot, span.start, span.end);
    return range ? { range, raw: span.raw } : null;
  }).filter(Boolean);
}

function promptRanges(container, tags) {
  const locator = createLocator(container);
  let cursor = 0;
  return tags.map(tag => {
    const found = locator.find(squeezedKey(tag.prompt), { from: cursor, wrap: true });
    if (!found) return null;
    cursor = found.end;
    return { range: found.range, raw: tag.prompt };
  });
}

function comparableText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasCard(container, tagId) {
  return Boolean(container.querySelector(`.stia-card[data-tag-id="${CSS.escape(tagId)}"]`));
}

function orphanDrawElements(container) {
  return [...container.querySelectorAll('draw')].filter(element => !element.closest('.stia-card'));
}

function isEmptyElement(element) {
  if (element.querySelector(MEDIA_SELECTOR)) return false;
  return !element.textContent.trim();
}

/* 删掉一段跨块的范围之后，两端会留下空壳：空 <p>、只剩序号的 <ol><li>。
   从边界节点往上清到消息容器为止，只清没有任何可见内容的元素。 */
function pruneEmptyAncestors(node, container) {
  let current = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  while (current && current !== container && container.contains(current)) {
    if (current.closest('.stia-card')) break;
    if (!isEmptyElement(current)) break;
    const parent = current.parentElement;
    current.remove();
    current = parent;
  }
}

/* 卡片落进了只剩它一个的块（比如整段都是提示词的 <p>）时，把壳去掉让卡片直接站在原地。 */
function settleCard(cardRoot, container) {
  let parent = cardRoot.parentElement;
  while (parent && parent !== container && container.contains(parent)) {
    if (buildVisibleTextSnapshot(parent).text.trim()) break;
    if (parent.querySelector(VISIBLE_MEDIA_SELECTOR)) break;
    const next = parent.parentElement;
    parent.replaceWith(cardRoot);
    parent = next;
  }
}

function replaceRange(range, replacement, raw, container) {
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
  const { startContainer, endContainer } = range;
  range.deleteContents();
  range.insertNode(replacement);
  pruneEmptyAncestors(endContainer, container);
  pruneEmptyAncestors(startContainer, container);
  settleCard(replacement, container);
}

function removeRange(range, raw, container) {
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
  const { startContainer, endContainer } = range;
  range.deleteContents();
  pruneEmptyAncestors(endContainer, container);
  pruneEmptyAncestors(startContainer, container);
}

/* 提示词模板里有空行时，酒馆会把它渲染成多个 <p>；<draw> 是未知元素，HTML 解析器在第一个
   </p> 处就把它隐式闭合，于是 <draw> 只包住第一段，后面几段成了裸段落。
   换完锚点之后，把提示词剩下的部分紧接着锚点位置在 DOM 里找出来一并删掉。
   只删紧跟在锚点之后、与提示词逐字对得上的文本，正文一个字不碰。 */
function sweepRemainder(container, anchor, prompt, consumedText) {
  const promptKey = squeezedKey(prompt);
  const consumedKey = squeezedKey(consumedText);
  if (!consumedKey || consumedKey.length >= promptKey.length || !promptKey.startsWith(consumedKey)) {
    return 0;
  }
  const remainder = promptKey.slice(consumedKey.length);
  const locator = createLocator(container);
  const cursor = locator.cursorAfter(anchor);
  const found = locator.find(remainder, { from: cursor, wrap: false });
  if (!found || found.start !== cursor) return 0;
  removeRange(found.range, null, container);
  return 1;
}

function consumeDrawElement(container, element, tag, replacement = null) {
  const elementText = buildVisibleTextSnapshot(element).text;
  const anchor = replacement || document.createElement('span');
  if (!replacement) anchor.className = 'stia-card stia-card--marker';
  const parent = element.parentElement;
  element.replaceWith(anchor);
  sweepRemainder(container, anchor, tag.prompt, elementText);
  if (replacement) {
    settleCard(replacement, container);
    return;
  }
  anchor.remove();
  pruneEmptyAncestors(parent, container);
}

function matchingTag(tags, prompt, used) {
  const key = squeezedKey(prompt);
  return tags.find(tag => !used.has(tag.tagId) && key && squeezedKey(tag.prompt) === key);
}

function prefixMatchingTag(tags, text, used) {
  const key = squeezedKey(text);
  return tags.find(tag => !used.has(tag.tagId) && key && squeezedKey(tag.prompt).startsWith(key));
}

/* 卡片已经在原地，但提示词原文又冒出来了（改写后酒馆用 mes 重建了这一层，
   或者别的扩展重新渲染了正文）——把多出来的那份原文清掉，卡片不动。 */
function cleanupExistingSources(container, tags) {
  const existing = tags.filter(tag => hasCard(container, tag.tagId));
  if (!existing.length) return;
  const used = new Set();

  for (const element of orphanDrawElements(container)) {
    const tag = prefixMatchingTag(existing, buildVisibleTextSnapshot(element).text, used);
    if (!tag) continue;
    used.add(tag.tagId);
    consumeDrawElement(container, element, tag);
  }

  const markupMatches = textRanges(container).map(item => {
    const parsed = parseDrawTags(item.raw, { warn: () => {} });
    const tag = matchingTag(existing, parsed[0]?.prompt || '', used);
    if (tag) used.add(tag.tagId);
    return { ...item, tag };
  }).filter(item => item.tag);
  for (const { range, raw } of markupMatches.reverse()) removeRange(range, raw, container);

  const remaining = existing.filter(tag => !used.has(tag.tagId));
  if (!remaining.length) return;
  const promptMatches = promptRanges(container, remaining);
  const promptRemovals = remaining.map((tag, index) => ({
    tag,
    range: promptMatches[index]?.range,
    raw: promptMatches[index]?.raw,
  })).filter(item => item.range);
  for (const { range, raw } of promptRemovals.reverse()) removeRange(range, raw, container);
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
      onRemove: actions.remove,
    });
    cards.set(tag.tagId, card);
    card.render();
    return card;
  }

  function mount(messageId, tags) {
    const message = compat.messageElement(messageId);
    const container = message?.querySelector('.mes_text');
    if (!container) return { mounted: 0, fallback: 0 };
    /* 小铅笔打开着：这一层正被改写，酒馆随后会用 mes 整个重建。此时不动 DOM，
       等重建完成再由 DOM 监听重新挂载。 */
    if (container.querySelector('textarea')) return { mounted: 0, fallback: 0 };

    const activeTagIds = new Set(tags.map(tag => tag.tagId));
    for (const card of [...container.querySelectorAll('.stia-card[data-tag-id]')]) {
      const tagId = card.getAttribute('data-tag-id');
      if (!tagId || activeTagIds.has(tagId)) continue;
      card.remove();
      cards.delete(tagId);
    }

    /* 楼底 fallback 里的卡片不算"挂好了"：每轮都先摘下来，让它有机会回到原地
       （比如上一轮 DOM 还没重建完、提示词原文还没回来时它才被迫落到楼底）。
       仍然找不到锚点时原样放回去，不重建元素。 */
    const detached = new Map();
    for (const list of [...container.querySelectorAll(':scope > .stia-card-list')]) {
      for (const card of [...list.querySelectorAll('.stia-card[data-tag-id]')]) {
        detached.set(card.getAttribute('data-tag-id'), card);
        card.remove();
      }
      list.remove();
    }

    cleanupExistingSources(container, tags);

    const missing = tags
      .map((tag, index) => ({ tag, index }))
      .filter(({ tag }) => !hasCard(container, tag.tagId));
    if (!missing.length) return { mounted: 0, fallback: 0 };

    let unresolved = missing;
    let mounted = 0;
    const drawElements = orphanDrawElements(container);
    if (drawElements.length) {
      const anchored = unresolved.slice(0, drawElements.length);
      for (const [{ tag }, anchor] of anchored.map((item, index) => [item, drawElements[index]])) {
        if (!anchor) continue;
        const card = makeCard(tag);
        consumeDrawElement(container, anchor, tag, card.root);
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
      replaceRange(range, card.root, raw, container);
    }

    mounted += replacements.length;
    const mountedIds = new Set(replacements.map(item => item.tag.tagId));
    unresolved = unresolved.filter(({ tag }) => !mountedIds.has(tag.tagId)
      && !hasCard(container, tag.tagId));
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
      replaceRange(range, card.root, raw, container);
    }
    mounted += promptReplacements.length;
    const promptMountedIds = new Set(promptReplacements.map(item => item.tag.tagId));
    unresolved = unresolved.filter(({ tag }) => !promptMountedIds.has(tag.tagId)
      && !hasCard(container, tag.tagId));
    if (!unresolved.length) return { mounted, fallback: 0 };

    const fallback = document.createElement('div');
    fallback.className = 'stia-card-list';
    container.append(fallback);
    for (const { tag } of unresolved) {
      const previous = detached.get(tag.tagId);
      if (previous && cards.has(tag.tagId)) {
        fallback.append(previous);
      } else {
        fallback.append(makeCard(tag).root);
      }
    }
    return { mounted, fallback: unresolved.length };
  }

  function renderTag(tagId) {
    cards.get(tagId)?.render();
  }

  /* 把卡片从楼里摘掉，并清掉它留下的空壳（只剩它一个的 <p>、空的楼底列表）。 */
  function removeCard(tagId) {
    const card = cards.get(tagId);
    cards.delete(tagId);
    const root = card?.root;
    if (!root?.isConnected) return false;
    const container = root.closest('.mes_text');
    const parent = root.parentElement;
    root.remove();
    if (container && parent) pruneEmptyAncestors(parent, container);
    return true;
  }

  store.subscribe(() => {
    for (const card of cards.values()) {
      if (card.root.isConnected) card.render();
    }
  });

  return { mount, renderTag, removeCard };
}
