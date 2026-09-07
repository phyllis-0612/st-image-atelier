'use strict';

const crypto = require('node:crypto');
const adapter = require('../adapters/openai-images');
const { AppError, publicError } = require('../utils/errors');
const { assertUuidLike, validatePrompt } = require('../utils/validation');

function timestamp() { return new Date().toISOString(); }

class GenerationService {
  constructor({ metadata, preset, storage }) {
    this.metadata = metadata;
    this.preset = preset;
    this.storage = storage;
    this.running = new Map();
    this.creationLocks = new Map();
  }

  async resolveTags(tagIds) {
    return tagIds.map(tagId => {
      const tag = this.metadata.getTag(tagId);
      if (!tag) return { tagId, tag: null, attempts: [], results: [] };
      const attempts = Object.values(this.metadata.index.attempts)
        .filter(item => item.tagId === tagId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const results = tag.resultIds.map(id => this.metadata.getResult(id)).filter(Boolean);
      return { tagId, tag, attempts, results };
    });
  }

  async generate(input) {
    const rawAttemptId = String(input?.attemptId ?? '');
    if (this.creationLocks.has(rawAttemptId)) {
      return this.creationLocks.get(rawAttemptId);
    }
    const pending = this.createAttempt(input);
    this.creationLocks.set(rawAttemptId, pending);
    try {
      return await pending;
    } finally {
      this.creationLocks.delete(rawAttemptId);
    }
  }

  async createAttempt(input) {
    const tagId = assertUuidLike(input.tagId, 'tagId');
    const attemptId = assertUuidLike(input.attemptId, 'attemptId', { allowAuto: true });
    const prompt = validatePrompt(input.prompt);
    const requestMode = input.requestMode === 'auto' ? 'auto' : 'manual';
    if (requestMode === 'auto' && attemptId !== `auto:${tagId}`) {
      throw new AppError('VALIDATION_FAILED', '自动生图幂等键无效');
    }

    const existing = this.metadata.getAttempt(attemptId);
    if (existing) return existing;

    const preset = await this.preset.get();
    const apiKey = await this.preset.getSecret();
    const settings = await this.preset.getSettings();
    const parameters = {
      size: input.parameters?.size
        || preset.ratioMap?.[input.parameters?.ratio]
        || preset.defaultSize,
      quality: input.parameters?.quality || preset.defaultQuality,
      count: Math.min(4, Math.max(1, Number(input.parameters?.count) || preset.defaultCount)),
      extraBody: input.parameters?.extraBody || {},
    };
    const attempt = {
      attemptId,
      tagId,
      requestMode,
      presetId: 'default',
      presetNameSnapshot: preset.name,
      model: preset.selectedModel,
      parameters,
      status: 'queued',
      resultIds: [],
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp(),
      completedAt: null,
      schemaVersion: 1,
    };
    const tag = this.metadata.getTag(tagId) || {
      tagId,
      chatId: String(input.chatId || ''),
      messageUuid: String(input.messageUuid || ''),
      tagOrdinal: Number(input.tagOrdinal) || 0,
      prompt,
      latestResultId: null,
      resultIds: [],
      autoAttempted: requestMode === 'auto',
      autoSuppressed: false,
      createdAt: timestamp(),
      updatedAt: timestamp(),
      schemaVersion: 1,
    };
    tag.prompt = prompt;
    if (requestMode === 'auto') tag.autoAttempted = true;
    await this.metadata.putTag(tag);
    await this.metadata.putAttempt(attempt);

    const controller = new AbortController();
    this.running.set(attemptId, controller);
    void this.execute({ attempt, tag, preset, apiKey, settings, prompt, parameters, controller });
    return attempt;
  }

  async execute(context) {
    const { attempt, tag, preset, apiKey, settings, prompt, parameters, controller } = context;
    try {
      attempt.status = 'generating';
      await this.metadata.putAttempt(attempt);
      const sources = await adapter.generate({
        preset, apiKey, settings, prompt, parameters, signal: controller.signal,
      });
      for (const source of sources) {
        if (controller.signal.aborted) throw new AppError('ATTEMPT_INTERRUPTED', '用户已取消');
        attempt.status = source.sourceType === 'url' ? 'downloading' : 'saving';
        await this.metadata.putAttempt(attempt);
        const resultId = crypto.randomUUID();
        const saved = await this.storage.saveSource(source, resultId, controller.signal);
        attempt.status = 'saving';
        await this.metadata.putAttempt(attempt);
        const result = {
          resultId,
          attemptId: attempt.attemptId,
          tagId: tag.tagId,
          generationIndex: source.generationIndex,
          chatId: tag.chatId,
          messageUuid: tag.messageUuid,
          prompt,
          presetId: 'default',
          presetNameSnapshot: preset.name,
          apiModel: preset.selectedModel,
          ...saved,
          sourceType: source.sourceType,
          status: 'available',
          createdAt: timestamp(),
          deletedAt: null,
          schemaVersion: 1,
        };
        await this.metadata.putResult(result);
        attempt.resultIds.push(resultId);
        tag.resultIds.push(resultId);
        tag.latestResultId = resultId;
      }
      attempt.status = 'succeeded';
      attempt.completedAt = timestamp();
      tag.updatedAt = timestamp();
      await this.metadata.transaction(index => {
        index.attempts[attempt.attemptId] = attempt;
        index.tags[tag.tagId] = tag;
      });
    } catch (error) {
      for (const resultId of attempt.resultIds) {
        const partial = this.metadata.getResult(resultId);
        if (partial?.localRelativePath) {
          await this.storage.remove(partial.localRelativePath).catch(() => {});
          partial.status = 'deleted';
          partial.deletedAt = timestamp();
        }
      }
      attempt.resultIds = [];
      const cancelled = controller.signal.aborted;
      const exposed = publicError(error);
      attempt.status = cancelled ? 'cancelled' : 'failed';
      attempt.errorCode = cancelled ? null : exposed.code;
      attempt.errorMessage = cancelled ? '已取消' : exposed.message;
      attempt.completedAt = timestamp();
      await this.metadata.transaction(index => {
        index.attempts[attempt.attemptId] = attempt;
      });
    } finally {
      this.running.delete(attempt.attemptId);
    }
  }

  async cancel(attemptId) {
    const attempt = this.metadata.getAttempt(attemptId);
    if (!attempt) throw new AppError('NOT_FOUND', 'attempt 不存在', 404);
    this.running.get(attemptId)?.abort();
    if (['queued', 'generating', 'downloading', 'saving'].includes(attempt.status)) {
      attempt.status = 'cancelled';
      attempt.completedAt = timestamp();
      await this.metadata.putAttempt(attempt);
    }
    return attempt;
  }
}

module.exports = { GenerationService };
