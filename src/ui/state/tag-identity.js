import { compactTag, warnLargeTags } from './tag-footprint.js';

function createUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function reconcileTagMetadata(message, parsedTags, uuid = createUuid) {
  message.extra ??= {};
  const previous = message.extra.stImageAtelier ?? {};
  const previousTags = Array.isArray(previous.tags) ? previous.tags : [];
  const unused = new Set(previousTags.map((_, index) => index));

  const tags = parsedTags.map((tag, ordinal) => {
    let matchedIndex = previousTags.findIndex((saved, index) =>
      unused.has(index) && saved.prompt === tag.prompt,
    );
    if (matchedIndex < 0 && previousTags[ordinal]?.prompt === tag.prompt) {
      matchedIndex = ordinal;
    }
    const saved = matchedIndex >= 0 ? previousTags[matchedIndex] : null;
    if (matchedIndex >= 0) unused.delete(matchedIndex);
    const record = {
      tagId: saved?.tagId || uuid(),
      prompt: tag.prompt,
      ordinal,
      ratio: tag.ratio,
      quality: tag.quality,
      count: tag.count,
      latestResultId: saved?.latestResultId || null,
      resultIds: Array.isArray(saved?.resultIds) ? saved.resultIds : [],
      resultRefs: Array.isArray(saved?.resultRefs) ? saved.resultRefs : [],
      status: saved?.status || 'idle',
      autoAttempted: Boolean(saved?.autoAttempted),
      autoSuppressed: Boolean(saved?.autoSuppressed),
    };
    const compact = compactTag(record);
    // Unknown legacy fields may hold image metadata. Do not discard them before the
    // explicit migration has copied known image paths into the gallery file.
    return saved && Object.keys(saved).some(key => !Object.hasOwn(compact, key))
      ? { ...saved, ...record } : compact;
  });

  const metadata = {
    messageUuid: previous.messageUuid || uuid(),
    tags,
    schemaVersion: 2,
  };
  message.extra.stImageAtelier = metadata;
  warnLargeTags(message);
  return {
    metadata,
    changed: JSON.stringify(previous) !== JSON.stringify(metadata),
  };
}
