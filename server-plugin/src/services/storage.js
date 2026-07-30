'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { AppError } = require('../utils/errors');
const { assertInside, detectImageType } = require('../utils/validation');

class StorageService {
  constructor(root, settingsProvider) {
    this.root = root;
    this.imagesDirectory = path.join(root, 'images');
    this.temporaryDirectory = path.join(root, 'tmp');
    this.settingsProvider = settingsProvider;
  }

  async initialize() {
    await fs.mkdir(this.imagesDirectory, { recursive: true });
    await fs.mkdir(this.temporaryDirectory, { recursive: true });
    return this;
  }

  async fetchUrl(url, signal) {
    const settings = await this.settingsProvider();
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !(settings.allowHttp && parsed.protocol === 'http:')) {
      throw new AppError('IMAGE_DOWNLOAD_FAILED', '图片 URL 协议不安全');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.downloadTimeoutMs || 60_000);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      let current = parsed;
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        const response = await fetch(current, { signal: controller.signal, redirect: 'manual' });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location || redirects === 3) throw new AppError('IMAGE_DOWNLOAD_FAILED', '图片重定向次数过多');
          current = new URL(location, current);
          if (current.protocol !== 'https:' && !(settings.allowHttp && current.protocol === 'http:')) {
            throw new AppError('IMAGE_DOWNLOAD_FAILED', '图片重定向到不安全协议');
          }
          continue;
        }
        if (!response.ok) throw new AppError('IMAGE_DOWNLOAD_FAILED', `HTTP ${response.status}`, 502, true);
        const length = Number(response.headers.get('content-length') || 0);
        if (length > settings.maxImageBytes) throw new AppError('IMAGE_DOWNLOAD_FAILED', '图片超过大小限制');
        return Buffer.from(await response.arrayBuffer());
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('IMAGE_DOWNLOAD_FAILED', error.message, 502, true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async saveSource(source, resultId, signal) {
    const settings = await this.settingsProvider();
    let bytes;
    if (source.sourceType === 'base64') {
      try {
        bytes = Buffer.from(source.value, 'base64');
      } catch {
        throw new AppError('UPSTREAM_RESPONSE_INVALID', 'Base64 图片无法解码');
      }
    } else {
      bytes = await this.fetchUrl(source.value, signal);
    }
    if (!bytes.length || bytes.length > settings.maxImageBytes) {
      throw new AppError('LOCAL_SAVE_FAILED', '图片为空或超过大小限制');
    }
    const imageType = detectImageType(bytes);
    if (!imageType) throw new AppError('LOCAL_SAVE_FAILED', '仅支持 PNG、JPEG、WebP');

    const date = new Date();
    const relative = path.join(
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      `${resultId}.${imageType.extension}`,
    );
    const finalPath = assertInside(this.imagesDirectory, path.join(this.imagesDirectory, relative));
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    const temporary = assertInside(this.temporaryDirectory, path.join(this.temporaryDirectory, `${crypto.randomUUID()}.tmp`));
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, finalPath);
    return {
      localRelativePath: relative.split(path.sep).join('/'),
      mimeType: imageType.mimeType,
      byteSize: bytes.length,
    };
  }

  resolve(relativePath) {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new AppError('VALIDATION_FAILED', '图片路径无效');
    }
    return assertInside(this.imagesDirectory, path.join(this.imagesDirectory, relativePath));
  }

  async remove(relativePath) {
    const file = this.resolve(relativePath);
    try {
      await fs.unlink(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

module.exports = { StorageService };
