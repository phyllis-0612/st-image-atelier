'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { readJson, atomicWriteJson } = require('../utils/atomic-json');

function emptyIndex() {
  return {
    schemaVersion: 1,
    tags: {},
    attempts: {},
    results: {},
    updatedAt: new Date().toISOString(),
  };
}

class MetadataStore {
  constructor(root) {
    this.root = root;
    this.directory = path.join(root, 'metadata');
    this.imagesDirectory = path.join(root, 'images');
    this.file = path.join(this.directory, 'index.json');
    this.backup = path.join(this.directory, 'index.backup.json');
    this.index = null;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      this.index = await readJson(this.file, emptyIndex());
    } catch (primaryError) {
      try {
        this.index = await readJson(this.backup, emptyIndex());
      } catch {
        this.index = emptyIndex();
      }
    }
    if (!Object.keys(this.index.results || {}).length) {
      const recovered = await this.rebuildFromImages();
      if (recovered > 0) await this.persist();
    }
    let changed = false;
    for (const attempt of Object.values(this.index.attempts)) {
      if (['queued', 'generating', 'downloading', 'saving'].includes(attempt.status)) {
        attempt.status = 'interrupted';
        attempt.errorCode = 'ATTEMPT_INTERRUPTED';
        attempt.errorMessage = '服务重启，原生成任务已中断';
        attempt.completedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await this.persist();
    return this;
  }

  async rebuildFromImages() {
    const files = [];
    async function walk(directory) {
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(fullPath);
        else files.push(fullPath);
      }
    }
    await walk(this.imagesDirectory);
    let recovered = 0;
    for (const file of files) {
      const match = /^([0-9a-f-]{36})\.(png|jpe?g|webp)$/i.exec(path.basename(file));
      if (!match || this.index.results[match[1]]) continue;
      const stat = await fs.stat(file);
      const mimeType = match[2].toLowerCase() === 'png'
        ? 'image/png'
        : match[2].toLowerCase() === 'webp' ? 'image/webp' : 'image/jpeg';
      this.index.results[match[1]] = {
        resultId: match[1],
        attemptId: `recovered:${match[1]}`,
        tagId: `recovered:${match[1]}`,
        generationIndex: 0,
        chatId: '',
        messageUuid: '',
        prompt: '从本地图片目录恢复的记录',
        presetId: 'default',
        presetNameSnapshot: '恢复记录',
        apiModel: 'unknown',
        localRelativePath: path.relative(this.imagesDirectory, file).split(path.sep).join('/'),
        mimeType,
        byteSize: stat.size,
        sourceType: 'url',
        status: 'available',
        createdAt: stat.birthtime.toISOString(),
        deletedAt: null,
        recovered: true,
        schemaVersion: 1,
      };
      recovered += 1;
    }
    return recovered;
  }

  async persist() {
    return this.transaction(() => {});
  }

  getTag(tagId) { return this.index.tags[tagId] || null; }
  getAttempt(attemptId) { return this.index.attempts[attemptId] || null; }
  getResult(resultId) { return this.index.results[resultId] || null; }

  async putTag(record) {
    await this.transaction(index => {
      index.tags[record.tagId] = structuredClone(record);
    });
    return record;
  }

  async putAttempt(record) {
    await this.transaction(index => {
      index.attempts[record.attemptId] = structuredClone(record);
    });
    return record;
  }

  async putResult(record) {
    await this.transaction(index => {
      index.results[record.resultId] = structuredClone(record);
    });
    return record;
  }

  async transaction(mutator) {
    const operation = this.writeChain.then(async () => {
      const next = structuredClone(this.index);
      await mutator(next);
      next.updatedAt = new Date().toISOString();
      await atomicWriteJson(this.file, next, { backupFile: this.backup });
      this.index = next;
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  listResults({ cursor, limit = 30 } = {}) {
    const all = Object.values(this.index.results)
      .filter(result => result.status === 'available')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const start = cursor ? Math.max(0, all.findIndex(item => item.resultId === cursor) + 1) : 0;
    const items = all.slice(start, start + Math.min(100, Math.max(1, limit)));
    return {
      items,
      nextCursor: start + items.length < all.length ? items.at(-1)?.resultId : null,
    };
  }

  availableResults() {
    return Object.values(this.index.results)
      .filter(result => result.status === 'available')
      .map(result => structuredClone(result));
  }
}

module.exports = { MetadataStore, emptyIndex };
