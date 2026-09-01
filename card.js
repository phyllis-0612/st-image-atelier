import { makeImageSaveable, openImageViewer } from '../media/image-viewer.js';

const ACTIVE_STATUSES = new Set(['queued', 'generating', 'downloading', 'saving']);

const STATUS_TEXT = {
  queued: '排队中',
  generating: '正在生成…',
  downloading: '正在下载图片…',
  saving: '正在保存到酒馆…',
  interrupted: '生成被中断',
  cancelled: '已取消',
};

function button(label, className, handler, symbol = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `stia-button ${className || ''}`.trim();
  if (symbol) {
    const icon = document.createElement('span');
    icon.className = 'stia-button__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = symbol;
    element.append(icon);
  }
  const text = document.createElement('span');
  text.textContent = label;
  element.append(text);
  element.addEventListener('click', handler);
  return element;
}

function promptDetails(prompt) {
  const details = document.createElement('details');
  details.className = 'stia-prompt';
  const summary = document.createElement('summary');
  summary.textContent = '◉  查看提示词';
  const text = document.createElement('pre');
  text.textContent = prompt;
  details.append(summary, text);
  return details;
}

function displaySize(value) {
  return String(value || '').replace(/(\d)x(\d)/gi, '$1×$2');
}

function statusHeading(symbol, title, subtitle, tone = '') {
  const heading = document.createElement('div');
  heading.className = `stia-card__status ${tone}`.trim();
  const icon = document.createElement('span');
  icon.className = 'stia-card__status-icon';
  icon.textContent = symbol;
  const copy = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = title;
  copy.append(strong);
  if (subtitle) {
    const small = document.createElement('small');
    small.textContent = subtitle;
    copy.append(small);
  }
  heading.append(icon, copy);
  return heading;
}

export function createCard({ tag, api, getState, onGenerate, onOpenGallery, onCancel }) {
  const root = document.createElement('section');
  root.className = 'stia-card';
  root.dataset.tagId = tag.tagId;
  root.setAttribute('aria-label', 'Image Atelier 生图卡片');

  function render() {
    const state = getState(tag.tagId) || {};
    const attempt = state.attempts?.[0];
    const available = (state.results || []).filter(result => result.status === 'available');
    const latest = available.find(result => result.resultId === state.tag?.latestResultId)
      || available.at(-1);
    const size = displaySize(attempt?.parameters?.size || '');
    const ratioLabel = {
      square: '方形',
      portrait: '竖图',
      landscape: '横图',
    }[tag.ratio] || '';
    root.replaceChildren();
    root.className = 'stia-card';

    if (latest) {
      root.classList.add('stia-card--succeeded');
      const media = document.createElement('div');
      media.className = 'stia-card__media';
      const image = document.createElement('img');
      image.className = 'stia-card__image';
      image.src = api.fileUrl(latest.resultId);
      image.alt = tag.prompt.slice(0, 120);
      image.loading = 'lazy';
      const openOriginal = () => openImageViewer({
        src: api.fileUrl(latest.resultId),
        alt: image.alt,
        filename: latest.resultId,
        prompt: tag.prompt,
        meta: [attempt?.model, size].filter(Boolean).join(' · '),
      });
      makeImageSaveable(image, openOriginal);
      media.append(image);
      if (size) {
        const badge = document.createElement('span');
        badge.className = 'stia-card__size';
        badge.textContent = size;
        media.append(badge);
      }
      const body = document.createElement('div');
      body.className = 'stia-card__body';
      const completion = document.createElement('div');
      completion.className = 'stia-card__completion';
      const done = document.createElement('span');
      done.className = 'stia-success';
      done.textContent = '✓ 已完成';
      const history = document.createElement('span');
      history.className = 'stia-muted';
      history.textContent = `历史 ${available.length} 张`;
      completion.append(done, history);
      const actions = document.createElement('div');
      actions.className = 'stia-actions stia-actions--fill';
      actions.append(
        button('重新生成', '', () => onGenerate(tag, 'manual'), '↻'),
        button('查看 / 保存', 'stia-button--square', openOriginal, '⌕'),
        button('画廊', 'stia-button--square', () => onOpenGallery(tag.tagId), '▦'),
      );
      body.append(completion, actions, promptDetails(tag.prompt));
      root.append(media, body);
      return;
    }

    const body = document.createElement('div');
    body.className = 'stia-card__body';
    if (attempt && ACTIVE_STATUSES.has(attempt.status)) {
      const isAutoQueue = attempt.status === 'queued' && attempt.requestMode === 'auto';
      root.classList.add(isAutoQueue ? 'stia-card--queued' : 'stia-card--generating');
      body.append(statusHeading(
        isAutoQueue ? '◷' : '◌',
        isAutoQueue ? '自动排队中' : (STATUS_TEXT[attempt.status] || '处理中'),
        isAutoQueue ? '等待当前生成任务完成' : `${attempt.model || '当前模型'} · ${size || '默认尺寸'}`,
        isAutoQueue ? 'is-warning' : 'is-accent',
      ));
      if (!isAutoQueue) {
        const shimmer = document.createElement('div');
        shimmer.className = 'stia-card__shimmer';
        body.append(shimmer);
      }
      body.append(button(
        isAutoQueue ? '取消排队' : '取消',
        'stia-button--ghost stia-button--full',
        () => onCancel(attempt.attemptId),
        '×',
      ));
      root.append(body);
      return;
    }

    if (attempt && ['failed', 'interrupted', 'cancelled'].includes(attempt.status)) {
      root.classList.add('stia-card--failed');
      body.append(statusHeading(
        '×',
        attempt.status === 'failed' ? '生成失败' : STATUS_TEXT[attempt.status],
        attempt.errorMessage || '请稍后重试',
        'is-danger',
      ));
      body.append(button('重试', 'stia-button--danger-soft stia-button--full', () => {
        onGenerate(tag, 'manual');
      }, '↻'));
      body.append(promptDetails(tag.prompt));
      root.append(body);
      return;
    }

    root.classList.add('stia-card--idle');
    body.append(statusHeading(
      '▧',
      '等待生成',
      `${attempt?.model || '使用当前预设模型'} · ${size || ratioLabel || '默认尺寸'}`,
      'is-accent',
    ));
    if (state.tag?.resultIds?.length) {
      const deleted = document.createElement('p');
      deleted.className = 'stia-muted';
      deleted.textContent = '上一张图片已删除，可以重新生成。';
      body.append(deleted);
    }
    body.append(
      promptDetails(tag.prompt),
      button(attempt ? '重新生成' : '生成图片', 'stia-button--primary stia-button--full', () => {
        onGenerate(tag, 'manual');
      }, '▧'),
    );
    root.append(body);
  }

  return { root, render };
}
