import { DEFAULT_PRESET, DEFAULT_SETTINGS, SCHEMA_VERSION } from './constants.js';

export function createDefaultSettings(now = new Date().toISOString()) {
  return { ...DEFAULT_SETTINGS, updatedAt: now, schemaVersion: SCHEMA_VERSION };
}

export function createDefaultPreset(now = new Date().toISOString()) {
  return {
    ...structuredClone(DEFAULT_PRESET),
    createdAt: now,
    updatedAt: now,
  };
}

export function createEmptyIndex(now = new Date().toISOString()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    tags: {},
    attempts: {},
    results: {},
    updatedAt: now,
  };
}

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
