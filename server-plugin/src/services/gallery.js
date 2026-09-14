'use strict';

const fs = require('node:fs');
const { AppError } = require('../utils/errors');
const { selectCleanupCandidates } = require('./retention');

class GalleryService {
  constructor({ metadata, storage }) {
    this.metadata = metadata;
    this.storage = storage;
    this.cleanupPromise = null;
  }

  list(query) {
    return this.metadata.listResults(query);
  }

  metadataList() {
    const items = this.metadata.allAvailableResults();
    return { items, total: items.length };
  }

  get(resultId) {
    const result = this.metadata.getResult(resultId);
    if (!result || result.status !== 'available' || !result.localRelativePath) {
      throw new AppError('NOT_FOUND', '图片不存在', 404);
    }
    return result;
  }

  stream(resultId, response, download = false) {
    const result = this.get(resultId);
    const file = this.storage.resolve(result.localRelativePath);
    response.type(result.mimeType);
    if (download) {
      response.setHeader('Content-Disposition', `attachment; filename="${result.resultId}.${result.localRelativePath.split('.').pop()}"`);
    } else {
      response.setHeader('Content-Disposition', `inline; filename="${result.resultId}.${result.localRelativePath.split('.').pop()}"`);
    }
    return fs.createReadStream(file).pipe(response);
  }

  async delete(resultId) {
    const result = this.get(resultId);
    await this.storage.remove(result.localRelativePath);
    const now = new Date().toISOString();
    await this.metadata.transaction(index => {
      const nextResult = index.results[resultId];
      const tag = index.tags[nextResult.tagId];
      delete index.results[resultId];
      if (tag) {
        tag.autoSuppressed = true;
        tag.resultIds = (tag.resultIds || []).filter(id => id !== resultId);
        const available = tag.resultIds
          .map(id => index.results[id])
          .filter(Boolean)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        tag.latestResultId = available[0]?.resultId || null;
        tag.updatedAt = now;
      }
    });
    return { resultId, status: 'deleted' };
  }

  async setFavorite(resultId, favorite) {
    this.get(resultId);
    await this.metadata.transaction(index => {
      index.results[resultId].favorite = favorite === true;
    });
    return this.metadata.getResult(resultId);
  }

  cleanup(settings) {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.performCleanup(settings).finally(() => {
      this.cleanupPromise = null;
    });
    return this.cleanupPromise;
  }

  async performCleanup(settings) {
    const selection = selectCleanupCandidates(this.metadata.availableResults(), settings);
    if (!selection.settings.galleryCleanupByAge && !selection.settings.galleryCleanupByCount) {
      return {
        enabled: false,
        candidateCount: 0,
        deletedCount: 0,
        failedCount: 0,
        keptCount: selection.availableCount,
        byAgeCount: 0,
        byCountCount: 0,
        deletedIds: [],
      };
    }

    const deletedIds = [];
    for (const result of selection.candidates) {
      try {
        await this.storage.remove(result.localRelativePath);
        deletedIds.push(result.resultId);
      } catch (error) {
        console.warn('[画笺] 自动清理图片失败', result.resultId, error);
      }
    }
    if (deletedIds.length) {
      const deleted = new Set(deletedIds);
      const timestamp = new Date().toISOString();
      await this.metadata.transaction(index => {
        const affectedTags = new Set();
        for (const resultId of deleted) {
          const result = index.results[resultId];
          if (!result) continue;
          affectedTags.add(result.tagId);
          delete index.results[resultId];
        }
        for (const tagId of affectedTags) {
          const tag = index.tags[tagId];
          if (!tag) continue;
          tag.resultIds = (tag.resultIds || []).filter(resultId => !deleted.has(resultId));
          const available = tag.resultIds
            .map(resultId => index.results[resultId])
            .filter(result => result?.status === 'available')
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
          tag.latestResultId = available[0]?.resultId || null;
          tag.autoSuppressed = true;
          tag.updatedAt = timestamp;
        }
      });
    }

    return {
      enabled: true,
      candidateCount: selection.candidates.length,
      deletedCount: deletedIds.length,
      failedCount: selection.candidates.length - deletedIds.length,
      keptCount: selection.availableCount - deletedIds.length,
      byAgeCount: selection.byAgeCount,
      byCountCount: selection.byCountCount,
      deletedIds,
    };
  }
}

module.exports = { GalleryService };
