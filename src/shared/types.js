/**
 * @typedef {'square'|'portrait'|'landscape'} DrawRatio
 * @typedef {'manual'|'auto'} RequestMode
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
 * Phase two reserves multi-preset selection, filters, favorites, references,
 * provider-specific options and cost fields. They are intentionally absent
 * from phase-one behavior.
 */
export {};
