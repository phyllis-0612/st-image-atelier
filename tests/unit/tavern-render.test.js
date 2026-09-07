/* 用酒馆同款 showdown + DOMPurify 走一遍真实渲染链路 —— 江给的原文（1.5.2）
   之前的用例都是手写 DOM 猜酒馆会渲染成什么样。这里直接用酒馆的转换器配置把 mes 渲染出来：
   <draw> 被消毒器剥掉、空行拆成 <p>、单换行变 <br>、"1. " 变 <ol><li>，
   然后断言卡片能整段接管、正文一个字不少。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import showdown from 'showdown';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { createMessageRenderer } from '../../src/ui/renderer/message-renderer.js';
import { parseDrawTags } from '../../src/ui/parser/draw-parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = fs.readFileSync(path.join(here, '../fixtures/tavern-markdown-prompt.txt'), 'utf8').trimEnd();
const BODY = '他把折扇收进腰间，转身走进走廊。';

/* 与 SillyTavern script.js 里 converter 的配置一致 */
function tavernRender(window, mes) {
  const converter = new showdown.Converter({
    emoji: true,
    literalMidWordUnderscores: true,
    parseImgDimensions: true,
    tables: true,
    underline: true,
    simpleLineBreaks: true,
    strikethrough: true,
    disableForced4SpacesIndentedSublists: true,
  });
  return createDOMPurify(window).sanitize(converter.makeHtml(mes));
}

function setup(mes) {
  const dom = new JSDOM('<!DOCTYPE html><div id="chat"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'Node', 'NodeFilter', 'CSS', 'HTMLElement', 'Element', 'Range']) {
    globalThis[key] = key === 'window' ? dom.window : dom.window[key];
  }
  if (!globalThis.CSS?.escape) {
    globalThis.CSS = { escape: value => String(value).replace(/[^\w-]/g, ch => `\\${ch}`) };
  }
  const message = dom.window.document.createElement('div');
  message.className = 'mes';
  message.setAttribute('mesid', '0');
  message.innerHTML = '<div class="mes_text"></div>';
  dom.window.document.querySelector('#chat').appendChild(message);
  const container = message.querySelector('.mes_text');
  const rebuild = () => { container.innerHTML = tavernRender(dom.window, mes); };
  rebuild();
  const tags = parseDrawTags(mes).map((tag, index) => ({ ...tag, tagId: `tag-${index}`, ordinal: index }));
  const renderer = createMessageRenderer({
    compat: { messageElement: () => message, chat: () => [{ mes }] },
    api: {},
    store: { state: { tagStates: new Map(), settings: {} }, subscribe() {}, setTag() {}, set() {} },
    actions: {},
  });
  return { container, renderer, rebuild, tags };
}

function leakedText(container) {
  const cardText = container.querySelector('.stia-card')?.textContent || '';
  return container.textContent.replace(cardText, '').replace(BODY, '').trim();
}

test('酒馆真实渲染：<draw> 被剥掉、序号变列表、单换行变 <br>，仍能整段替换成卡片', () => {
  const mes = `${BODY}\n\n<draw> ${PROMPT}\n </draw>`;
  const { container, renderer, tags } = setup(mes);
  assert.equal(container.querySelector('draw'), null, '前提：消毒器确实剥掉了 <draw>');
  assert.ok(container.querySelector('ol > li'), '前提：序号确实被渲染成了列表');
  assert.ok(container.querySelector('br'), '前提：单换行确实变成了 <br>');

  const result = renderer.mount('0', tags);
  assert.equal(result.fallback, 0, '不该落进楼底 fallback');
  assert.equal(result.mounted, 1);
  assert.equal(leakedText(container), '', '提示词不该留在楼里');
  assert.equal(container.querySelector(':scope > ol'), null, '空列表壳要清掉');
  assert.ok(container.textContent.includes(BODY), '正文必须原样保留');
});

test('酒馆真实渲染：改写关上后 DOM 重建，再挂载卡片回原地、原文不露', () => {
  const mes = `${BODY}\n\n<draw> ${PROMPT}\n </draw>`;
  const { container, renderer, rebuild, tags } = setup(mes);
  renderer.mount('0', tags);
  rebuild();
  assert.notEqual(leakedText(container), '', '前提：重建后原文确实回来了');

  const result = renderer.mount('0', tags);
  assert.equal(result.fallback, 0, '不该落进楼底 fallback');
  assert.equal(container.querySelectorAll('.stia-card').length, 1, '只能有一张卡');
  assert.equal(leakedText(container), '', '提示词不该留在楼里');
  assert.ok(container.textContent.includes(BODY), '正文必须原样保留');
});

test('酒馆真实渲染：提示词在正文中间时，前后正文都保留', () => {
  const after = '走廊尽头的光很亮。';
  const mes = `${BODY}\n\n<draw> ${PROMPT}\n </draw>\n\n${after}`;
  const { container, renderer, tags } = setup(mes);
  const result = renderer.mount('0', tags);
  assert.equal(result.fallback, 0, '不该落进楼底 fallback');
  assert.equal(leakedText(container).replace(after, '').trim(), '', '提示词不该留在楼里');
  assert.ok(container.textContent.includes(BODY) && container.textContent.includes(after), '前后正文都要在');
  const nodes = [...container.children].map(node => node.className.includes('stia-card') ? 'card' : node.tagName);
  assert.deepEqual(nodes, ['P', 'card', 'P'], '卡片应该站在两段正文之间');
});
