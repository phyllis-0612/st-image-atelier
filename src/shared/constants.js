export const MODULE_NAME = 'stImageAtelier';
export const DISPLAY_NAME = 'Image Atelier';
export const API_ROOT = '/api/plugins/st-image-atelier';
export const SCHEMA_VERSION = 1;

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
  SERVER_PLUGIN_UNAVAILABLE: 'SERVER_PLUGIN_UNAVAILABLE',
  NOT_FOUND: 'NOT_FOUND',
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  autoGenerate: false,
  allowHttp: false,
  maxImageBytes: 30 * 1024 * 1024,
  downloadTimeoutMs: 60_000,
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
