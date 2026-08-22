export const MODULE_NAME = 'stImageAtelier';
export const DISPLAY_NAME = 'Image Atelier';
export const API_ROOT = '/api/plugins/st-image-atelier';
export const SCHEMA_VERSION = 4;

export const ATTEMPT_STATUS = Object.freeze({
  IDLE: 'idle',
  QUEUED: 'queued',
  GENERATING: 'generating',
  DOWNLOADING: 'downloading',
  SAVING: 'saving',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  CANCELLED: 'cancelled',
});

export const RESULT_STATUS = Object.freeze({
  AVAILABLE: 'available',
  DELETED: 'deleted',
  MISSING: 'missing',
});

export const ERROR_CODES = Object.freeze({
  PRESET_NOT_CONFIGURED: 'PRESET_NOT_CONFIGURED',
  API_KEY_MISSING: 'API_KEY_MISSING',
  MODEL_NOT_SELECTED: 'MODEL_NOT_SELECTED',
  UPSTREAM_AUTH_FAILED: 'UPSTREAM_AUTH_FAILED',
  UPSTREAM_RATE_LIMITED: 'UPSTREAM_RATE_LIMITED',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_HTTP_ERROR: 'UPSTREAM_HTTP_ERROR',
  UPSTREAM_RESPONSE_INVALID: 'UPSTREAM_RESPONSE_INVALID',
  IMAGE_DOWNLOAD_FAILED: 'IMAGE_DOWNLOAD_FAILED',
  LOCAL_SAVE_FAILED: 'LOCAL_SAVE_FAILED',
  ATTEMPT_ALREADY_RUNNING: 'ATTEMPT_ALREADY_RUNNING',
  ATTEMPT_INTERRUPTED: 'ATTEMPT_INTERRUPTED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  DIRECT_FETCH_BLOCKED: 'DIRECT_FETCH_BLOCKED',
  SERVER_PLUGIN_UNAVAILABLE: 'SERVER_PLUGIN_UNAVAILABLE',
  NOT_FOUND: 'NOT_FOUND',
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  autoGenerate: false,
  generationProvider: 'openai',
  executionMode: 'direct',
  allowHttp: false,
  maxImageBytes: 30 * 1024 * 1024,
  downloadTimeoutMs: 60_000,
});

export const DEFAULT_NOVELAI_CONFIG = Object.freeze({
  // Keep this empty so a fresh install does not imply that only the official
  // NovelAI account/token flow is supported. Users may enter either an
  // official endpoint or a NovelAI-native compatible relay.
  baseUrl: '',
  generationPath: '/ai/generate-image',
  model: 'nai-diffusion-4-5-full',
  sampler: 'k_euler',
  noiseSchedule: 'karras',
  defaultSize: '832x1216',
  defaultCount: 1,
  steps: 28,
  scale: 5,
  cfgRescale: 0,
  seed: -1,
  negativePrompt: '',
  qualityTags: true,
  smea: false,
  smeaDyn: false,
  variety: true,
  timeoutMs: 180_000,
  ratioMap: {
    square: '1024x1024',
    portrait: '832x1216',
    landscape: '1216x832'
  },
  schemaVersion: 1
});

export const DEFAULT_ARTIST_PRESET = Object.freeze({
  id: 'default',
  name: '默认画师串',
  prompt: '',
  schemaVersion: 1
});

export const DEFAULT_PRESET = Object.freeze({
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
  timeoutMs: 180_000,
  extraBody: {},
  ratioMap: {
    square: '1024x1024',
    portrait: '1024x1536',
    landscape: '1536x1024'
  },
  schemaVersion: 1
});
