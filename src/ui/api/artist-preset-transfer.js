export const ARTIST_PRESET_EXPORT_FORMAT = 'st-image-atelier-artist-presets';
export const ARTIST_PRESET_EXPORT_VERSION = 1;

const MAX_PRESETS = 100;
const MAX_NAME_LENGTH = 120;
const MAX_PROMPT_LENGTH = 20000;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(source, keys) {
  for (const key of keys) {
    const value = text(source?.[key]);
    if (value) return value;
  }
  return '';
}

function transferablePreset(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`第 ${index + 1} 条画师串不是有效对象`);
  }
  const name = firstText(value, ['name', 'title']) || `导入画师串 ${index + 1}`;
  const prompt = firstText(value, [
    'positivePrompt', 'positive_prompt', 'prompt', 'fixedPrompt', 'stylePrompt',
  ]);
  const negativePrompt = firstText(value, [
    'negativePrompt', 'negative_prompt', 'uc', 'undesiredContent', 'negative',
  ]);
  if (!prompt && !negativePrompt) {
    throw new Error(`第 ${index + 1} 条画师串的正面和负面内容都为空`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`第 ${index + 1} 条画师串名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  }
  if (prompt.length > MAX_PROMPT_LENGTH || negativePrompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`第 ${index + 1} 条画师串的正面或负面内容不能超过 ${MAX_PROMPT_LENGTH} 个字符`);
  }
  return { name, prompt, negativePrompt };
}

export function createArtistPresetExport(presets, { exportedAt = new Date().toISOString() } = {}) {
  const items = (Array.isArray(presets) ? presets : [])
    .filter(preset => text(preset?.prompt) || text(preset?.negativePrompt))
    .map((preset, index) => transferablePreset(preset, index))
    .map(({ name, prompt, negativePrompt }) => ({
      name,
      positivePrompt: prompt,
      negativePrompt,
    }));
  if (!items.length) throw new Error('没有可导出的画师串预设');
  return {
    format: ARTIST_PRESET_EXPORT_FORMAT,
    version: ARTIST_PRESET_EXPORT_VERSION,
    exportedAt,
    presets: items,
  };
}

export function parseArtistPresetImport(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('JSON 根内容必须是对象或数组');
  if (!Array.isArray(payload)
    && payload.format
    && payload.format !== ARTIST_PRESET_EXPORT_FORMAT) {
    throw new Error('这不是 Image Atelier 画师串分享文件');
  }
  if (!Array.isArray(payload)
    && payload.format === ARTIST_PRESET_EXPORT_FORMAT
    && (!Number.isInteger(Number(payload.version)) || Number(payload.version) < 1)) {
    throw new Error('画师串分享文件版本无效');
  }
  if (!Array.isArray(payload)
    && payload.format === ARTIST_PRESET_EXPORT_FORMAT
    && Number(payload.version) > ARTIST_PRESET_EXPORT_VERSION) {
    throw new Error('该分享文件来自更高版本，请先更新 Image Atelier');
  }

  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.presets)
      ? payload.presets
      : Array.isArray(payload.artistPresets)
        ? payload.artistPresets
        : [payload];
  if (!candidates.length) throw new Error('分享文件中没有画师串预设');
  if (candidates.length > MAX_PRESETS) {
    throw new Error(`单次最多导入 ${MAX_PRESETS} 条画师串预设`);
  }
  return candidates.map(transferablePreset);
}
