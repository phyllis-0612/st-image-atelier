'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { readJson, atomicWriteJson } = require('../utils/atomic-json');
const { AppError } = require('../utils/errors');

function now() { return new Date().toISOString(); }

function defaultPreset() {
  const timestamp = now();
  return {
    id: 'default',
    name: '默认预设',
    providerType: 'openai-compatible',
    baseUrl: '',
    modelsPath: '/v1/models',
    generationPath: '/v1/images/generations',
    authMode: 'bearer',
    selectedModel: '',
    cachedModels: [],
    modelsFetchedAt: null,
    defaultSize: '1024x1024',
    defaultQuality: 'auto',
    defaultCount: 1,
    sendSize: true,
    sendQuality: true,
    sendN: true,
    timeoutMs: 180000,
    extraBody: {},
    ratioMap: {
      square: '1024x1024',
      portrait: '1024x1536',
      landscape: '1536x1024',
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    schemaVersion: 1,
  };
}

function defaultSettings() {
  return {
    enabled: true,
    autoGenerate: false,
    allowHttp: false,
    maxImageBytes: 30 * 1024 * 1024,
    downloadTimeoutMs: 60_000,
    schemaVersion: 1,
  };
}

function maskKey(key) {
  if (!key) return null;
  const suffix = key.length > 4 ? key.slice(-4) : '••••';
  return `sk-••••${suffix}`;
}

function sanitizePreset(input, current = defaultPreset()) {
  const output = { ...current };
  const stringFields = [
    'name', 'baseUrl', 'modelsPath', 'generationPath', 'selectedModel',
    'defaultSize', 'defaultQuality',
  ];
  for (const field of stringFields) {
    if (field in input) output[field] = String(input[field]).trim();
  }
  for (const field of ['sendSize', 'sendQuality', 'sendN']) {
    if (field in input) output[field] = Boolean(input[field]);
  }
  if ('defaultCount' in input) output.defaultCount = Math.min(4, Math.max(1, Number(input.defaultCount) || 1));
  if ('timeoutMs' in input) output.timeoutMs = Math.min(600_000, Math.max(30_000, Number(input.timeoutMs) || 180_000));
  if ('extraBody' in input) {
    if (!input.extraBody || typeof input.extraBody !== 'object' || Array.isArray(input.extraBody)) {
      throw new AppError('VALIDATION_FAILED', 'extraBody 必须是 JSON 对象');
    }
    output.extraBody = input.extraBody;
  }
  if ('ratioMap' in input && input.ratioMap && typeof input.ratioMap === 'object') {
    output.ratioMap = {
      square: String(input.ratioMap.square || output.ratioMap.square),
      portrait: String(input.ratioMap.portrait || output.ratioMap.portrait),
      landscape: String(input.ratioMap.landscape || output.ratioMap.landscape),
    };
  }
  if ('cachedModels' in input && Array.isArray(input.cachedModels)) {
    output.cachedModels = input.cachedModels
      .slice(0, 10_000)
      .map(item => ({ id: String(item?.id || ''), ...(item?.ownedBy ? { ownedBy: String(item.ownedBy) } : {}) }))
      .filter(item => item.id);
  }
  if ('modelsFetchedAt' in input) {
    output.modelsFetchedAt = input.modelsFetchedAt ? String(input.modelsFetchedAt) : null;
  }
  output.id = 'default';
  output.providerType = 'openai-compatible';
  output.authMode = 'bearer';
  output.updatedAt = now();
  return output;
}

class PresetService {
  constructor(root) {
    this.configDirectory = path.join(root, 'config');
    this.secretDirectory = path.join(root, 'secrets');
    this.presetsFile = path.join(this.configDirectory, 'presets.json');
    this.settingsFile = path.join(this.configDirectory, 'settings.json');
    this.secretFile = path.join(this.secretDirectory, 'default.json');
  }

  async initialize() {
    await fs.mkdir(this.configDirectory, { recursive: true });
    await fs.mkdir(this.secretDirectory, { recursive: true, mode: 0o700 });
    const presets = await readJson(this.presetsFile, { activePresetId: 'default', items: [defaultPreset()], schemaVersion: 1 });
    if (!presets.items?.length) presets.items = [defaultPreset()];
    await atomicWriteJson(this.presetsFile, presets);
    const settings = await readJson(this.settingsFile, defaultSettings());
    await atomicWriteJson(this.settingsFile, settings);
    return this;
  }

  async getSettings() { return readJson(this.settingsFile, defaultSettings()); }

  async updateSettings(patch) {
    const current = await this.getSettings();
    const next = {
      ...current,
      ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
      ...(typeof patch.autoGenerate === 'boolean' ? { autoGenerate: patch.autoGenerate } : {}),
      ...(typeof patch.allowHttp === 'boolean' ? { allowHttp: patch.allowHttp } : {}),
      updatedAt: now(),
    };
    await atomicWriteJson(this.settingsFile, next);
    return next;
  }

  async getSecret() {
    const value = await readJson(this.secretFile, {});
    return value.apiKey || '';
  }

  async clearSecret() {
    await atomicWriteJson(this.secretFile, {});
  }

  async list() {
    const data = await readJson(this.presetsFile, { activePresetId: 'default', items: [defaultPreset()] });
    const key = await this.getSecret();
    return {
      activePresetId: 'default',
      items: data.items.slice(0, 1).map(item => ({
        ...item,
        hasApiKey: Boolean(key),
        apiKeyMask: maskKey(key),
      })),
    };
  }

  async get() {
    const data = await readJson(this.presetsFile, { items: [defaultPreset()] });
    return data.items?.[0] || defaultPreset();
  }

  async update(patch) {
    const current = await this.get();
    const next = sanitizePreset(patch, current);
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      await atomicWriteJson(this.secretFile, { apiKey: patch.apiKey.trim(), updatedAt: now() });
      try { await fs.chmod(this.secretFile, 0o600); } catch {}
    }
    await atomicWriteJson(this.presetsFile, {
      activePresetId: 'default',
      items: [next],
      schemaVersion: 1,
    });
    return (await this.list()).items[0];
  }
}

module.exports = { PresetService, defaultPreset, defaultSettings, maskKey, sanitizePreset };
