'use strict';

const fs = require('node:fs');
const { AppError } = require('../utils/errors');

class GalleryService {
  constructor({ metadata, storage }) {
    this.metadata = metadata;
    this.storage = storage;
  }

  list(query) {
    return this.metadata.listResults(query);
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
      nextResult.status = 'deleted';
      nextResult.deletedAt = now;
      const tag = index.tags[nextResult.tagId];
      if (tag) {
        tag.autoSuppressed = true;
        const available = tag.resultIds
          .map(id => index.results[id])
          .filter(item => item?.status === 'available')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        tag.latestResultId = available[0]?.resultId || null;
        tag.updatedAt = now;
      }
    });
    return this.metadata.getResult(resultId);
  }
}

module.exports = { GalleryService };
