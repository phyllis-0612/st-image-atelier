import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTagMetadata } from '../../src/ui/state/tag-identity.js';

const tag = prompt => ({ prompt, ratio: undefined, quality: undefined, count: 1 });

test('首次生成并在刷新时复用 messageUuid 和 tagId', () => {
  let count = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}`;
  const message = { extra: {} };
  const first = reconcileTagMetadata(message, [tag('A'), tag('B')], uuid);
  const ids = first.metadata.tags.map(item => item.tagId);
  const messageUuid = first.metadata.messageUuid;
  const second = reconcileTagMetadata(message, [tag('A'), tag('B')], uuid);
  assert.deepEqual(second.metadata.tags.map(item => item.tagId), ids);
  assert.equal(second.metadata.messageUuid, messageUuid);
  assert.equal(second.changed, false);
});

test('编辑后未变标签保留 ID，变更标签获得新 ID', () => {
  let count = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}`;
  const message = { extra: {} };
  const first = reconcileTagMetadata(message, [tag('A'), tag('B')], uuid).metadata;
  const next = reconcileTagMetadata(message, [tag('A'), tag('C')], uuid).metadata;
  assert.equal(next.tags[0].tagId, first.tags[0].tagId);
  assert.notEqual(next.tags[1].tagId, first.tags[1].tagId);
});
