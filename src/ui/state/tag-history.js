import { compactTag } from './tag-footprint.js';

export function hasGenerationHistory(tag, state) {
  return [tag, state?.tag].some(value => value && (
    value.autoAttempted || value.autoSuppressed || value.latestResultId
    || value.resultIds?.length || value.resultRefs?.length || value.results?.length
    || value.attempts?.length || (value.status && value.status !== 'idle')
  )) || Boolean(state?.attempts?.length || state?.results?.length);
}

export function mergeTagHistory(tagId, saved, states) {
  const values = states.filter(Boolean);
  const results = [...new Map(values.flatMap(value => value.results || [])
    .map(result => [result.resultId, result])).values()]
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const attempts = [...new Map(values.flatMap(value => value.attempts || [])
    .map(attempt => [attempt.attemptId, attempt])).values()]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const tags = [saved, ...values.map(value => value.tag)].filter(Boolean);
  if (!tags.length) return { tagId, tag: null, attempts, results };
  const resultIds = [...new Set(tags.flatMap(tag => tag.resultIds || [])
    .concat(results.map(result => result.resultId)))];
  const resultRefs = [...new Map(tags.flatMap(tag => tag.resultRefs || [])
    .concat(results).filter(result => result.localRelativePath)
    .map(result => [result.resultId, result])).values()];
  const tag = compactTag({
    ...tags[0],
    resultIds, resultRefs,
    latestResultId: results.at(-1)?.resultId || tags.find(tag => tag.latestResultId)?.latestResultId,
    autoAttempted: tags.some(tag => tag.autoAttempted),
    autoSuppressed: tags.some(tag => tag.autoSuppressed),
  });
  return { tagId, tag, attempts, results };
}
