import test from 'node:test';
import assert from 'node:assert/strict';
import { removeDrawTagFromMessage, stripDrawTag } from '../../src/ui/state/tag-removal.js';

const PROMPT = 'masterpiece, a young lord on the threshold';
const TAG = '<draw ratio="portrait">\n' + PROMPT + '\n</draw>';

function message(mes, tags, extra = {}) {
  return {
    is_user: false,
    mes,
    swipes: [mes],
    swipe_id: 0,
    extra: { stImageAtelier: { messageUuid: 'msg-1', tags, schemaVersion: 2 }, ...extra },
  };
}

test('删除楼尾注入的标签：正文原样保留，多余空行一并收掉', () => {
  const msg = message(`他把折扇收进腰间。\n\n${TAG}`, [{ tagId: 'tag-1', prompt: PROMPT, ordinal: 0 }]);
  const result = removeDrawTagFromMessage(msg, 'tag-1');
  assert.equal(result.changed, true);
  assert.equal(result.removedMarkup, true);
  assert.equal(msg.mes, '他把折扇收进腰间。');
  assert.equal(msg.swipes[0], msg.mes, 'swipes 要同步，左右滑回来不能长回去');
  assert.equal(msg.extra.stImageAtelier, undefined, '一条不剩时整个命名空间删掉');
});

test('标签夹在两段正文中间：两段正文之间保留一个空行', () => {
  const msg = message(`前文。\n\n${TAG}\n\n后文。`, [{ tagId: 'tag-1', prompt: PROMPT, ordinal: 0 }]);
  removeDrawTagFromMessage(msg, 'tag-1');
  assert.equal(msg.mes, '前文。\n\n后文。');
});

test('标签和正文在同一行：用一个空格接上', () => {
  const { text } = stripDrawTag(`开头 <draw>${PROMPT}</draw> 结尾`, { ordinal: 0, prompt: PROMPT });
  assert.equal(text, '开头 结尾');
});

test('只删指定的那一个标签，其余标签保留并重排 ordinal', () => {
  const other = '<draw>一只猫</draw>';
  const msg = message(`${other}\n\n${TAG}\n\n<draw>一只狗</draw>`, [
    { tagId: 'tag-cat', prompt: '一只猫', ordinal: 0 },
    { tagId: 'tag-1', prompt: PROMPT, ordinal: 1 },
    { tagId: 'tag-dog', prompt: '一只狗', ordinal: 2 },
  ]);
  removeDrawTagFromMessage(msg, 'tag-1');
  assert.equal(msg.mes, `${other}\n\n<draw>一只狗</draw>`);
  assert.deepEqual(msg.extra.stImageAtelier.tags.map(tag => [tag.tagId, tag.ordinal]), [['tag-cat', 0], ['tag-dog', 1]]);
});

test('元数据 ordinal 与正文顺序不一致时按提示词原文兜底定位', () => {
  const msg = message(`<draw>一只猫</draw>\n\n${TAG}`, [{ tagId: 'tag-1', prompt: PROMPT, ordinal: 5 }]);
  removeDrawTagFromMessage(msg, 'tag-1');
  assert.equal(msg.mes, '<draw>一只猫</draw>');
});

test('其他 swipe 里同样的标签也剥掉，不含标签的 swipe 不动', () => {
  const msg = message(`正文。\n\n${TAG}`, [{ tagId: 'tag-1', prompt: PROMPT, ordinal: 0 }]);
  msg.swipes = [msg.mes, '另一条完全不同的回复。', `别的正文。\n\n${TAG}`];
  msg.swipe_id = 0;
  removeDrawTagFromMessage(msg, 'tag-1');
  assert.deepEqual(msg.swipes, ['正文。', '另一条完全不同的回复。', '别的正文。']);
});

test('标签不在这条消息的元数据里时什么都不动', () => {
  const msg = message(`正文。\n\n${TAG}`, [{ tagId: 'tag-1', prompt: PROMPT, ordinal: 0 }]);
  const before = JSON.stringify(msg);
  const result = removeDrawTagFromMessage(msg, 'tag-missing');
  assert.equal(result.changed, false);
  assert.equal(JSON.stringify(msg), before);
});

test('正文里已经没有字面标签（只剩元数据）时也能把元数据清掉', () => {
  const msg = message('正文。', [{ tagId: 'tag-1', prompt: PROMPT, ordinal: 0 }]);
  const result = removeDrawTagFromMessage(msg, 'tag-1');
  assert.equal(result.changed, true);
  assert.equal(result.removedMarkup, false);
  assert.equal(msg.mes, '正文。');
  assert.equal(msg.extra.stImageAtelier, undefined);
});
