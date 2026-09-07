/**
 * @typedef {'square'|'portrait'|'landscape'} DrawRatio
 * @typedef {'manual'|'auto'} RequestMode
 * @typedef {'openai'|'novelai'} GenerationProvider
 * @typedef {'idle'|'queued'|'generating'|'downloading'|'saving'|'succeeded'|'failed'|'interrupted'|'cancelled'} AttemptStatus
 *
 * @typedef {object} DrawTag
 * @property {string} prompt
 * @property {number} ordinal
 * @property {DrawRatio|undefined} ratio
 * @property {string|undefined} quality
 * @property {number} count
 * @property {number} start
 * @property {number} end
 *
 * @typedef {object} TagRecord
 * @property {string} tagId
 * @property {string} chatId
 * @property {string} messageUuid
 * @property {number} tagOrdinal
 * @property {string} prompt
 * @property {string|null} latestResultId
 * @property {string[]} resultIds
 * @property {boolean} autoAttempted
 * @property {boolean} autoSuppressed
 *
 * GPT API 预设与 NovelAI 画师串预设分别保存在 extension_settings；密钥仅保存在
 * accountStorage。过滤、收藏、参考图与成本字段仍保留给后续版本。
 */
export {};
