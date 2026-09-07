'use strict';

const { MetadataStore } = require('./metadata');
const { PresetService } = require('./preset');
const { StorageService } = require('./storage');
const { GenerationService } = require('./generation');
const { GalleryService } = require('./gallery');
const { resolveUserRoot, userKey } = require('../compat/user-data');

class ServiceRegistry {
  constructor() {
    this.entries = new Map();
  }

  async get(request) {
    const key = userKey(request);
    if (!this.entries.has(key)) {
      this.entries.set(key, this.create(resolveUserRoot(request)).catch(error => {
        this.entries.delete(key);
        throw error;
      }));
    }
    return this.entries.get(key);
  }

  async create(root) {
    const preset = await new PresetService(root).initialize();
    const metadata = await new MetadataStore(root).initialize();
    const storage = await new StorageService(root, () => preset.getSettings()).initialize();
    const generation = new GenerationService({ metadata, preset, storage });
    const gallery = new GalleryService({ metadata, storage });
    return { root, preset, metadata, storage, generation, gallery };
  }
}

module.exports = { ServiceRegistry };
