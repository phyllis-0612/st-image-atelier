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

// "等回包 118 秒 · 收图 131 秒（6.2 MB） · 保存 3 秒": shows which stage a slow image spent its time in.
export function imageTimingBreakdown(result) {
  const timing = result?.transferTiming;
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!timing || !valid(timing.waitMs) || !valid(timing.receiveMs)) return '';
  const seconds = value => `${Math.round(value / 1000)} 秒`;
  const size = valid(timing.receiveBytes) && timing.receiveBytes > 0
    ? `（${(timing.receiveBytes / 1048576).toFixed(1)} MB）` : '';
  return `等回包 ${seconds(timing.waitMs)} · 收图 ${seconds(timing.receiveMs)}${size}`
    + (valid(timing.saveMs) ? ` · 保存 ${seconds(timing.saveMs)}` : '');
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
