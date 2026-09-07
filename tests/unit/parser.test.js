import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDrawTags, shouldProcessMessage } from '../../src/ui/parser/draw-parser.js';
import { hasChangedDrawSource } from '../../src/ui/events/message-events.js';
import {
  findDrawMarkupSpans,
  findNormalizedTextSpan,
} from '../../src/ui/renderer/message-renderer.js';

test('解析单标签、多行与前后正文', () => {
  const tags = parseDrawTags('正文\n<draw>\n一只猫\n在窗边\n</draw>\n结尾');
  assert.equal(tags.length, 1);
  assert.equal(tags[0].prompt, '一只猫\n在窗边');
  assert.equal(tags[0].count, 1);
});

test('解析多个标签与白名单属性', () => {
  const warnings = [];
  const tags = parseDrawTags(
    '<draw ratio="portrait" quality="high" count="4" onclick="x">A</draw>'
    + '<draw count="99">B</draw>',
    { warn: value => warnings.push(value) },
  );
  assert.equal(tags.length, 2);
  assert.deepEqual(
    { ratio: tags[0].ratio, quality: tags[0].quality, count: tags[0].count },
    { ratio: 'portrait', quality: 'high', count: 4 },
  );
  assert.equal(tags[1].count, 4);
  assert.equal(warnings.length, 1);
});

test('未闭合、空标签和嵌套标签被忽略', () => {
  assert.equal(parseDrawTags('<draw>abc').length, 0);
  assert.equal(parseDrawTags('<draw> </draw>').length, 0);
  assert.equal(parseDrawTags('<draw>outer <draw>inner</draw></draw>').length, 0);
});

test('只处理普通 AI 消息', () => {
  assert.equal(shouldProcessMessage({ is_user: false, mes: '<draw>x</draw>' }), true);
  assert.equal(shouldProcessMessage({ is_user: true, mes: '<draw>x</draw>' }), false);
  assert.equal(shouldProcessMessage({ is_user: false, is_system: true, mes: '<draw>x</draw>' }), false);
});

test('渲染文字中的 draw 标签可按原始位置定位', () => {
  const text = '开头 <draw ratio="portrait">一只猫</draw> 中间 <draw>一只狗</draw> 结尾';
  const spans = findDrawMarkupSpans(text);
  assert.equal(spans.length, 2);
  assert.equal(text.slice(spans[0].start, spans[0].end), '<draw ratio="portrait">一只猫</draw>');
  assert.equal(text.slice(spans[1].start, spans[1].end), '<draw>一只狗</draw>');
});

test('标签被酒馆过滤后仍可按提示词原文定位', () => {
  const text = '正文之前\n  两名成年女子在玉池边，\n保持礼貌距离。  \n正文之后';
  const span = findNormalizedTextSpan(text, '两名成年女子在玉池边， 保持礼貌距离。');
  assert.ok(span);
  assert.equal(
    text.slice(span.start, span.end),
    '两名成年女子在玉池边，\n保持礼貌距离。',
  );
});

test('正文完成后追加 draw 标签会被识别为新来源', () => {
  const previous = '正文已经生成完成。';
  const message = {
    is_user: false,
    mes: `${previous}\n<draw>稍后追加的生图提示词</draw>`,
  };
  assert.equal(hasChangedDrawSource(message, previous), true);
  assert.equal(hasChangedDrawSource(message, message.mes), false);
});
