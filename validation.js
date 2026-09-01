'use strict';

const path = require('node:path');
const { AppError } = require('./errors');

function assertUuidLike(value, field, { allowAuto = false } = {}) {
  const text = String(value ?? '');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(text) && !(allowAuto && /^auto:[0-9a-f-]{36}$/i.test(text))) {
    throw new AppError('VALIDATION_FAILED', `${field} 格式无效`);
  }
  return text;
}

function assertInside(baseDirectory, candidate) {
  const base = path.resolve(baseDirectory);
  const resolved = path.resolve(candidate);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('VALIDATION_FAILED', '文件路径越界');
  }
  return resolved;
}

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20_000) {
    throw new AppError('VALIDATION_FAILED', '提示词必须为 1-20000 个字符');
  }
  return prompt.trim();
}

module.exports = { assertUuidLike, assertInside, detectImageType, validatePrompt };
