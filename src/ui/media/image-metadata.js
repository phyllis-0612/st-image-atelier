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
