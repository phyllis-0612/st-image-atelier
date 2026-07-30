const ALLOWED_RATIOS = new Set(['square', 'portrait', 'landscape']);
const ATTRIBUTE_PATTERN = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const DRAW_PATTERN = /<draw\b([^>]*)>([\s\S]*?)<\/draw\s*>/gi;

function escapeForText(value) {
  return String(value ?? '').replace(/\u0000/g, '');
}

export function parseDrawTags(source, { warn = console.warn } = {}) {
  const text = escapeForText(source);
  const tags = [];
  let match;

  while ((match = DRAW_PATTERN.exec(text)) !== null) {
    const prompt = match[2].trim();
    if (!prompt || /<draw\b/i.test(prompt)) {
      continue;
    }

    const attributes = {};
    let attributeMatch;
    ATTRIBUTE_PATTERN.lastIndex = 0;
    while ((attributeMatch = ATTRIBUTE_PATTERN.exec(match[1])) !== null) {
      const name = attributeMatch[1].toLowerCase();
      const value = attributeMatch[2] ?? attributeMatch[3] ?? '';
      if (!['ratio', 'quality', 'count'].includes(name)) {
        warn(`[Image Atelier] 忽略未知属性: ${name}`);
        continue;
      }
      attributes[name] = value;
    }

    const ratio = ALLOWED_RATIOS.has(attributes.ratio) ? attributes.ratio : undefined;
    const parsedCount = Number.parseInt(attributes.count ?? '1', 10);
    const count = Number.isFinite(parsedCount) ? Math.min(4, Math.max(1, parsedCount)) : 1;

    tags.push({
      prompt,
      ordinal: tags.length,
      ratio,
      quality: attributes.quality || undefined,
      count,
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
    });
  }

  return tags;
}

export function shouldProcessMessage(message) {
  return Boolean(
    message
    && message.is_user === false
    && !message.is_system
    && !message.extra?.reasoning_only
    && typeof message.mes === 'string',
  );
}
