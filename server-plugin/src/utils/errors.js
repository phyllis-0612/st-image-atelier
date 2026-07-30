'use strict';

const MESSAGES = {
  PRESET_NOT_CONFIGURED: 'API 预设未配置',
  API_KEY_MISSING: '缺少 API 密钥',
  MODEL_NOT_SELECTED: '未选择模型',
  UPSTREAM_AUTH_FAILED: 'API 鉴权失败，请检查密钥',
  UPSTREAM_RATE_LIMITED: 'API 限流，请稍后重试',
  UPSTREAM_TIMEOUT: '请求超时',
  UPSTREAM_HTTP_ERROR: '上游服务错误',
  UPSTREAM_RESPONSE_INVALID: '返回格式不兼容',
  IMAGE_DOWNLOAD_FAILED: '图片下载失败',
  LOCAL_SAVE_FAILED: '本地保存失败',
  ATTEMPT_ALREADY_RUNNING: '该标签正在生成中',
  ATTEMPT_INTERRUPTED: '生成被中断',
  VALIDATION_FAILED: '请求参数无效',
  SERVER_PLUGIN_UNAVAILABLE: '服务端插件不可用',
  NOT_FOUND: '未找到请求的资源',
};

class AppError extends Error {
  constructor(code, details, status = 400, retryable = false) {
    super(MESSAGES[code] || '未知错误');
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.status = status;
    this.retryable = retryable;
  }
}

function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/Bearer\s+[^\s"',]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-[REDACTED]');
}

function publicError(error) {
  const appError = error instanceof AppError
    ? error
    : new AppError('UPSTREAM_HTTP_ERROR', redact(error?.message), 500, true);
  return {
    code: appError.code,
    message: appError.message,
    retryable: appError.retryable,
    ...(appError.details ? { details: redact(String(appError.details)) } : {}),
  };
}

module.exports = { AppError, publicError, redact, MESSAGES };
