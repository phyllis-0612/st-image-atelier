import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDrawTags, shouldProcessMessage } from '../../src/ui/parser/draw-parser.js';

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
