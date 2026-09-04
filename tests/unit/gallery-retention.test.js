import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  normalizeRetentionSettings,
  selectCleanupCandidates,
} from '../../src/ui/gallery/retention.js';

const require = createRequire(import.meta.url);
const serverRetention = require('../../server-plugin/src/services/retention');

function result(resultId, createdAt, status = 'available') {
  return { resultId, createdAt, status };
}

test('保留规则会取时间和数量条件的并集，并始终按最旧优先', () => {
  const currentTime = Date.parse('2026-09-04T12:00:00.000Z');
  const values = [
    result('newest', '2026-09-04T00:00:00.000Z'),
    result('expired', '2026-08-20T00:00:00.000Z'),
    result('middle', '2026-09-01T00:00:00.000Z'),
    result('overflow', '2026-08-29T00:00:00.000Z'),
    result('already-deleted', '2026-01-01T00:00:00.000Z', 'deleted'),
  ];
  const settings = {
    galleryCleanupByAge: true,
    galleryMaxAgeDays: 7,
    galleryCleanupByCount: true,
    galleryMaxCount: 2,
  };
  const selected = selectCleanupCandidates(values, settings, currentTime);
  assert.deepEqual(selected.candidates.map(item => item.resultId), ['expired', 'overflow']);
  assert.equal(selected.byAgeCount, 1);
  assert.equal(selected.byCountCount, 2);
  assert.equal(selected.availableCount, 4);

  const serverSelected = serverRetention.selectCleanupCandidates(values, settings, currentTime);
  assert.deepEqual(
    serverSelected.candidates.map(item => item.resultId),
    selected.candidates.map(item => item.resultId),
  );
});

test('无效配置会被限制到安全范围，无日期记录不会因时间规则被误删', () => {
  assert.deepEqual(normalizeRetentionSettings({
    galleryCleanupByAge: 'true',
    galleryMaxAgeDays: -4,
    galleryCleanupByCount: true,
    galleryMaxCount: 99_999,
  }), {
    galleryCleanupByAge: false,
    galleryMaxAgeDays: 1,
    galleryCleanupByCount: true,
    galleryMaxCount: 10_000,
  });
  const selected = selectCleanupCandidates(
    [result('unknown-date', ''), result('old', '2020-01-01T00:00:00.000Z')],
    { galleryCleanupByAge: true, galleryMaxAgeDays: 7 },
    Date.parse('2026-09-04T00:00:00.000Z'),
  );
  assert.deepEqual(selected.candidates.map(item => item.resultId), ['old']);
});
