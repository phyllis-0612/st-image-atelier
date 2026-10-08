export const MAX_TAG_RESULTS = 8;
export const MAX_TAG_BYTES = 20_000;
const MAX_REFERENCE_BYTES = 1_400;

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

export function tagBytes(chat) {
  let total = 0;
  for (const message of chat || []) {
    const variants = [message, ...(Array.isArray(message?.swipe_info) ? message.swipe_info : [])];
    for (const variant of variants) {
      const tags = variant?.extra?.stImageAtelier?.tags;
      if (Array.isArray(tags)) total += bytes(tags);
    }
  }
  return total;
}

export function warnLargeTags(message, warn = console.warn) {
  const tags = message?.extra?.stImageAtelier?.tags;
  if (!Array.isArray(tags) || bytes(tags) <= MAX_TAG_BYTES) return;
  warn('[画笺] 单楼 tags 超过 20KB', {
    bytes: bytes(tags),
    fields: tags.map((tag, index) => ({
      tag: index,
      bytes: bytes(tag),
      fields: Object.fromEntries(Object.entries(tag).map(([name, value]) => [name, bytes(value)])),
    })),
  });
}

export function compactTag(tag) {
  const refs = Array.isArray(tag?.resultRefs) ? tag.resultRefs : [];
  const ids = [...new Set((Array.isArray(tag?.resultIds) ? tag.resultIds : refs.map(ref => ref.resultId))
    .filter(id => typeof id === 'string' && id.length <= 128))].slice(-MAX_TAG_RESULTS);
  const references = refs.filter(ref => ids.includes(ref?.resultId))
    .map(ref => ({
      resultId: ref.resultId,
      localRelativePath: String(ref.localRelativePath || '').slice(0, 256),
      createdAt: String(ref.createdAt || '').slice(0, 32),
    }))
    .filter(ref => ref.localRelativePath && !/^(?:data:|blob:|https?:)/i.test(ref.localRelativePath));
  while (references.length && bytes(references) > MAX_REFERENCE_BYTES) references.shift();
  return {
    tagId: tag.tagId,
    prompt: tag.prompt,
    ordinal: tag.ordinal,
    status: tag.status || 'idle',
    ...(tag.ratio ? { ratio: tag.ratio } : {}),
    ...(tag.quality ? { quality: tag.quality } : {}),
    ...(tag.count ? { count: tag.count } : {}),
    latestResultId: ids.includes(tag.latestResultId) ? tag.latestResultId : ids.at(-1) || null,
    resultIds: ids,
    resultRefs: references,
    autoAttempted: tag.autoAttempted === true,
    autoSuppressed: tag.autoSuppressed === true,
  };
}

// Old result objects may contain whole API responses or data URLs. Import only known metadata.
export function legacyResult(tag, value) {
  if (!value?.resultId || !value?.localRelativePath
    || /^(?:data:|blob:|https?:)/i.test(value.localRelativePath)) return null;
  const fields = [
    'resultId', 'attemptId', 'tagId', 'generationIndex', 'chatId', 'messageUuid',
    'negativePrompt', 'provider', 'presetId', 'presetNameSnapshot', 'artistPresetId',
    'artistPresetNameSnapshot', 'artistPromptSnapshot', 'artistNegativePromptSnapshot',
    'generationSeed', 'apiModel', 'localRelativePath', 'mimeType', 'byteSize',
    'sourceType', 'storageMode', 'generationDurationMs', 'createdAt', 'favorite',
    'compatibilityRetry',
  ];
  const result = Object.fromEntries(fields.filter(field => Object.hasOwn(value, field))
    .map(field => [field, value[field]]));
  result.tagId = result.tagId || tag.tagId;
  result.storageMode = value.storageMode || (/^\/?user\/images\//.test(value.localRelativePath)
    ? 'direct' : 'server');
  result.prompt = String(value.prompt || value.promptSnapshot || tag.prompt || '');
  result.parameters = {
    size: value.parameters?.size ?? null,
    quality: value.parameters?.quality ?? null,
  };
  result.status = 'available';
  return result;
}
