'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function integerInRange(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function normalizeRetentionSettings(value = {}) {
  return {
    galleryCleanupByAge: value.galleryCleanupByAge === true,
    galleryMaxAgeDays: integerInRange(value.galleryMaxAgeDays, 7, 1, 3650),
    galleryCleanupByCount: value.galleryCleanupByCount === true,
    galleryMaxCount: integerInRange(value.galleryMaxCount, 200, 1, 10_000),
  };
}

function createdTime(result) {
  const parsed = Date.parse(result?.createdAt || '');
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function selectCleanupCandidates(results, value = {}, currentTime = Date.now()) {
  const settings = normalizeRetentionSettings(value);
  const available = (Array.isArray(results) ? results : [])
    .filter(result => result?.status === 'available')
    .sort((left, right) => createdTime(left) - createdTime(right)
      || String(left.resultId || '').localeCompare(String(right.resultId || '')));
  const byAge = settings.galleryCleanupByAge
    ? available.filter(result => createdTime(result) < currentTime - settings.galleryMaxAgeDays * DAY_MS)
    : [];
  const overflow = settings.galleryCleanupByCount
    ? Math.max(0, available.length - settings.galleryMaxCount)
    : 0;
  const byCount = available.slice(0, overflow);
  const selected = new Set([...byAge, ...byCount].map(result => result.resultId));
  return {
    settings,
    availableCount: available.length,
    byAgeCount: byAge.length,
    byCountCount: byCount.length,
    candidates: available.filter(result => selected.has(result.resultId)),
  };
}

module.exports = { normalizeRetentionSettings, selectCleanupCandidates };
