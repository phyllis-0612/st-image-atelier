import { SCHEMA_VERSION } from '../../shared/constants.js';
import { DirectError, bytesToBase64 } from './openai-direct.js';

export const GALLERY_METADATA_FILE = 'st-image-atelier-gallery.json';
export const GALLERY_METADATA_URL = `/user/files/${GALLERY_METADATA_FILE}`;
const DOCUMENT_SCHEMA_VERSION = 2;

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export function normalizeGalleryRecord(value = {}) {
  const {
    promptSnapshot,
    resolvedPrompt,
    negativePromptSnapshot,
    resolvedNegativePrompt,
    deletedAt,
    ...rest
  } = value;
  const provider = value.provider === 'novelai'
    || value.presetId === 'novelai'
    || value.artistPresetId
    ? 'novelai'
    : 'openai';
  return {
    ...rest,
    prompt: String(promptSnapshot || value.prompt || resolvedPrompt || ''),
    negativePrompt: String(negativePromptSnapshot || value.negativePrompt || resolvedNegativePrompt || ''),
    favorite: value.favorite === true,
    provider,
    status: 'available',
    schemaVersion: SCHEMA_VERSION,
  };
}

function emptyDocument() {
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    results: {},
    attempts: {},
    updatedAt: new Date().toISOString(),
  };
}

function normalizeDocument(value) {
  const document = emptyDocument();
  const source = value?.results && typeof value.results === 'object' ? value.results : {};
  for (const item of Object.values(source)) {
    if (!item?.resultId || item.status !== 'available') continue;
    document.results[item.resultId] = normalizeGalleryRecord(item);
  }
  document.attempts = value?.attempts && typeof value.attempts === 'object' && !Array.isArray(value.attempts)
    ? clone(value.attempts) : {};
  document.updatedAt = String(value?.updatedAt || document.updatedAt);
  return document;
}

export function createGalleryMetadataStore({ readDocument, writeDocument }) {
  let document = null;
  let initializePromise = null;
  let writeChain = Promise.resolve();

  async function transaction(mutator) {
    const operation = writeChain.then(async () => {
      const next = clone(document);
      await mutator(next);
      next.updatedAt = new Date().toISOString();
      await writeDocument(next);
      document = next;
    });
    writeChain = operation.catch(() => {});
    return operation;
  }

  async function initialize({ legacyItems = [] } = {}) {
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      document = normalizeDocument(await readDocument());
      const before = JSON.stringify(document.results);
      for (const item of legacyItems || []) {
        if (!item?.resultId || item.status !== 'available') continue;
        if (!document.results[item.resultId]) {
          document.results[item.resultId] = normalizeGalleryRecord(item);
        }
      }
      if (before !== JSON.stringify(document.results) || (legacyItems || []).length) {
        await transaction(() => {});
      }
      return api;
    })();
    try {
      return await initializePromise;
    } catch (error) {
      initializePromise = null;
      document = null;
      throw error;
    }
  }

  function ready() {
    if (!document) throw new Error('Gallery metadata store is not initialized');
  }

  const api = {
    initialize,
    values() {
      ready();
      return Object.values(document.results).map(clone);
    },
    attemptsForTag(tagId) {
      ready();
      return Object.values(document.attempts).filter(item => item?.tagId === tagId).map(clone);
    },
    getAttempt(attemptId) {
      ready();
      const attempt = document.attempts[attemptId];
      return attempt ? clone(attempt) : null;
    },
    async putAttempts(attempts) {
      ready();
      if (!attempts?.length) return;
      await transaction(next => {
        for (const attempt of attempts) {
          if (attempt?.attemptId && attempt?.tagId) next.attempts[attempt.attemptId] = clone(attempt);
        }
      });
    },
    async removeAttempts(attemptIds) {
      ready();
      if (!attemptIds?.some(id => document.attempts[id])) return;
      await transaction(next => { for (const id of attemptIds) delete next.attempts[id]; });
    },
    get(resultId) {
      ready();
      const value = document.results[resultId];
      return value ? clone(value) : null;
    },
    has(resultId) {
      ready();
      return Boolean(document.results[resultId]);
    },
    async putMany(items) {
      ready();
      await transaction(next => {
        for (const item of items || []) {
          if (!item?.resultId || item.status !== 'available') continue;
          next.results[item.resultId] = normalizeGalleryRecord(item);
        }
      });
      return (items || []).map(item => api.get(item.resultId)).filter(Boolean);
    },
    async update(resultId, patch) {
      ready();
      const current = document.results[resultId];
      if (!current) return null;
      await transaction(next => {
        next.results[resultId] = normalizeGalleryRecord({ ...current, ...patch, resultId });
      });
      return api.get(resultId);
    },
    async removeMany(resultIds) {
      ready();
      const existingIds = (resultIds || []).filter(resultId => document.results[resultId]);
      if (!existingIds.length) return;
      await transaction(next => {
        for (const resultId of existingIds) delete next.results[resultId];
      });
    },
    remove(resultId) {
      return api.removeMany([resultId]);
    },
  };
  return api;
}

export function createSillyTavernGalleryMetadataStore(compat, fetchImpl = globalThis.fetch) {
  return createGalleryMetadataStore({
    async readDocument() {
      const response = await fetchImpl(`${GALLERY_METADATA_URL}?t=${Date.now()}`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (response.status === 404) return emptyDocument();
      if (!response.ok) {
        throw new DirectError('LOCAL_SAVE_FAILED', `读取画廊元数据失败（HTTP ${response.status}）`, response.status);
      }
      try {
        return await response.json();
      } catch {
        throw new DirectError('LOCAL_SAVE_FAILED', '画廊元数据文件不是有效 JSON');
      }
    },
    async writeDocument(document) {
      const bytes = new TextEncoder().encode(JSON.stringify(document));
      const response = await fetchImpl('/api/files/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: compat.headers(),
        body: JSON.stringify({
          name: GALLERY_METADATA_FILE,
          data: bytesToBase64(bytes),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new DirectError(
          'LOCAL_SAVE_FAILED',
          payload?.error || `写入画廊元数据失败（HTTP ${response.status}）`,
          response.status,
        );
      }
    },
  });
}

export function createMemoryGalleryMetadataStore(initialDocument = null) {
  let document = initialDocument ? clone(initialDocument) : emptyDocument();
  const store = createGalleryMetadataStore({
    readDocument: async () => clone(document),
    writeDocument: async value => { document = clone(value); },
  });
  Object.defineProperty(store, 'document', { get: () => clone(document) });
  return store;
}
