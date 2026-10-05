export function imageDuration(result, attempt) {
  let milliseconds = result?.generationDurationMs;
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) {
    if (!result?.attemptId || result.attemptId !== attempt?.attemptId) return '';
    const start = Date.parse(attempt.createdAt);
    const end = Date.parse(attempt.completedAt || result.createdAt);
    milliseconds = end - start;
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  }
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return `${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分` : ''}${remainder || !hours && !minutes ? `${remainder}秒` : ''}`;
}

// Use the image's saved snapshot; never infer old images from the active preset.
export function imageMetadata(result = {}, attempt = {}) {
  const provider = result?.provider || attempt?.provider;
  let quality;
  if (result?.compatibilityRetry?.adjustedParameters?.includes('quality')
    || attempt?.compatibilityRetry?.adjustedParameters?.includes('quality')) {
    quality = null;
  } else if (Object.hasOwn(result?.parameters || {}, 'quality')) {
    quality = result.parameters.quality;
  } else {
    quality = attempt?.parameters?.quality;
  }
  return {
    presetName: result?.presetNameSnapshot || attempt?.presetNameSnapshot
      || (provider === 'novelai' || result?.presetId === 'novelai' ? 'NovelAI' : '预设未记录'),
    quality: provider === 'novelai' || result?.presetId === 'novelai' ? '不适用'
      : quality === null ? '未发送' : String(quality || '未记录'),
    model: result?.apiModel || attempt?.model || '未知模型',
    size: String(result?.parameters?.size || attempt?.parameters?.size || '')
      .replace(/(\d)x(\d)/gi, '$1×$2'),
  };
}
