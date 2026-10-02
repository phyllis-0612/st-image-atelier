import { makeImageSaveable, openImageViewer } from '../media/image-viewer.js';

import { ACTIVE_STATUSES } from '../state/generation-state.js';

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

export function createCard({
  tag,
  api,
  getState,
  getSettings = () => ({}),
  onGenerate,
  onAdjustRegenerate,
  onOpenGallery,
  onOpenSettings,
  onCancel,
  onRemove,
}) {
  const root = document.createElement('section');
  root.className = 'stia-card';
  root.dataset.tagId = tag.tagId;
  root.setAttribute('aria-label', '画笺生图卡片');
  let renderedSignature;
  let renderedBody;
  let mediaCache;
  let currentView;

  // 图片只绑定一次事件；复用后读取最新快照，避免回调仍指向旧提示词或旧结果。
  function openOriginal() {
    const { latest, actualPrompt, size, attempt, imageSrc } = currentView;
    return openImageViewer({
      src: imageSrc,
      alt: actualPrompt.slice(0, 120),
      filename: latest.resultId,
      prompt: actualPrompt,
      meta: [attempt?.model, size].filter(Boolean).join(' · '),
    });
  }

  function adjustRegenerate() {
    const { latest, attempt, actualPrompt, actualNegativePrompt } = currentView;
    return onAdjustRegenerate(tag, {
      prompt: actualPrompt,
      negativePrompt: actualNegativePrompt,
      provider: latest?.provider || attempt?.provider || 'openai',
      ...(latest ? { result: latest } : {}),
      attempt,
    });
  }

  /* 一键删除：卡片、消息里的 <draw> 注入词、标签元数据一起清掉，不留痕迹。
     只在失败和待生成两种状态提供；已出图的走画廊删除，生成中的先取消。 */
  function removeButton() {
    return button('删除', 'stia-button--ghost stia-card__remove', () => onRemove(tag), '×');
  }

  function pendingControls(attempts, { showRoll = true } = {}) {
    const pending = document.createElement('div');
    pending.className = 'stia-card__pending';
    const hint = document.createElement('small');
    hint.className = 'stia-muted';
    hint.textContent = `仍有 ${attempts.length} 个任务在生成；并行重 roll 不会停止旧请求，返回的图片都会保存`;
    pending.append(hint);
    const actions = document.createElement('div');
    actions.className = 'stia-actions stia-actions--fill';
    if (showRoll) actions.append(button('并行重 roll', 'stia-button--primary', () => onGenerate(tag, 'manual'), '↻'));
    if (onOpenSettings) actions.append(button('换 Key / 预设', 'stia-button--ghost', onOpenSettings, '⚙'));
    pending.append(actions);
    for (const attempt of attempts) {
      const row = document.createElement('div');
      row.className = 'stia-card__task';
      const copy = document.createElement('span');
      copy.className = 'stia-card__task-copy';
      const name = document.createElement('strong');
      name.textContent = `${attempt.backupForAttemptId ? '备用 · ' : ''}${attempt.presetNameSnapshot || attempt.model || '生成任务'} · ${String(attempt.attemptId || '').slice(-6)}`;
      const status = document.createElement('small');
      status.textContent = attempt.statusMessage || STATUS_TEXT[attempt.status] || '处理中';
      copy.append(name, status);
      const cancelLabel = attempts.length === 1 ? (attempt.status === 'queued' ? '取消排队' : '取消') : '取消此任务';
      row.append(copy, button(cancelLabel, 'stia-button--ghost', () => onCancel(attempt.attemptId), '×'));
      pending.append(row);
    }
    return pending;
  }

  function render() {
    const state = getState(tag.tagId) || {};
    const attempts = state.attempts || [];
    const activeAttempts = attempts.filter(item => ACTIVE_STATUSES.has(item.status));
    const activeAttempt = activeAttempts[0];
    const available = (state.results || []).filter(result => result.status === 'available');
    const latest = available.find(result => result.resultId === state.tag?.latestResultId)
      || available.at(-1);
    const resultAttempt = attempts.find(item => item.attemptId === latest?.attemptId);
    const hasParallelWork = activeAttempts.length > 1
      || activeAttempts.some(item => item.parallel)
      || (resultAttempt?.parallel && activeAttempts.some(item => item.createdAt <= resultAttempt.createdAt));
    const attempt = latest && (!activeAttempts.length || hasParallelWork)
      ? (resultAttempt || attempts[0]) : (activeAttempt || attempts[0]);
    const actualPrompt = latest?.prompt
      || latest?.promptSnapshot
      || attempt?.promptSnapshot
      || attempt?.resolvedPrompt
      || tag.prompt;
    const actualNegativePrompt = latest?.negativePrompt
      || latest?.negativePromptSnapshot
      || attempt?.negativePromptSnapshot
      || '';
    const canAdjust = getSettings()?.enablePromptOverrideRegenerate === true
      && typeof onAdjustRegenerate === 'function';
    const size = displaySize(attempt?.parameters?.size || '');
    const ratioLabel = {
      square: '方形',
      portrait: '竖图',
      landscape: '横图',
    }[tag.ratio] || '';
    const active = activeAttempts.length > 0;
    const mode = active && !(latest && hasParallelWork) ? 'active' : latest ? 'succeeded'
      : attempt && ['failed', 'interrupted', 'cancelled'].includes(attempt.status) ? 'failed' : 'idle';
    const imageSrc = mode === 'succeeded' ? api.fileUrl(latest.resultId) : '';
    currentView = { latest, attempt, actualPrompt, actualNegativePrompt, size, imageSrc };
    // 只比较实际画面需要的数据，不受其他卡片、更新时间、收藏或无关设置影响。
    const signature = JSON.stringify(mode === 'active'
      ? [mode, attempt.attemptId, attempt.status, attempt.requestMode, attempt.statusMessage,
        attempt.model, size, Boolean(latest)]
      : mode === 'succeeded'
        ? [mode, latest.resultId, imageSrc, actualPrompt, size, available.length, canAdjust]
        : [mode, attempt?.status, attempt?.model, attempt?.errorMessage, Boolean(attempt),
          size, ratioLabel, actualPrompt, canAdjust, Boolean(state.tag?.resultIds?.length)])
      + JSON.stringify(activeAttempts.map(item => [item.attemptId, item.status, item.statusMessage, item.model, item.presetNameSnapshot, item.parameters?.size]));
    if (signature === renderedSignature) return;
    const promptOpen = root.querySelector?.('.stia-prompt')?.open || false;
    const details = () => {
      const element = promptDetails(actualPrompt);
      element.open = promptOpen;
      return element;
    };
    if (mode !== 'succeeded') root.replaceChildren();
    // 真正删除图片后释放缓存；重新生成期间保留，以便取消或失败后恢复原图。
    if (!latest) mediaCache = null;
    root.className = 'stia-card';

    if (mode === 'active') {
      const body = document.createElement('div');
      body.className = 'stia-card__body';
      const isAutoQueue = activeAttempt.status === 'queued' && activeAttempt.requestMode === 'auto';
      const isRegenerating = Boolean(latest) && !isAutoQueue;
      root.classList.add(isAutoQueue ? 'stia-card--queued' : 'stia-card--generating');
      body.append(statusHeading(
        isAutoQueue ? '◷' : '◌',
        isAutoQueue
          ? '自动排队中'
          : (isRegenerating ? '正在重新生成…' : (STATUS_TEXT[activeAttempt.status] || '处理中')),
        isAutoQueue
          ? '等待当前生成任务完成'
          : (activeAttempts.length > 1 ? `${activeAttempts.length} 个生成任务并行，旧请求继续接图` : (activeAttempt.statusMessage || `${activeAttempt.model || '当前模型'} · ${size || '默认尺寸'}`)),
        isAutoQueue ? 'is-warning' : 'is-accent',
      ));
      if (!isAutoQueue) {
        const shimmer = document.createElement('div');
        shimmer.className = 'stia-card__shimmer';
        body.append(shimmer);
      }
      body.append(pendingControls(activeAttempts));
      root.append(body);
      renderedBody = body;
      renderedSignature = signature;
      return;
    }

    if (latest) {
      root.classList.add('stia-card--succeeded');
      if (mediaCache?.resultId !== latest.resultId || mediaCache?.src !== imageSrc) {
        const media = document.createElement('div');
        media.className = 'stia-card__media';
        const image = document.createElement('img');
        image.className = 'stia-card__image';
        image.src = imageSrc;
        image.loading = 'lazy';
        makeImageSaveable(image, openOriginal);
        media.append(image);
        mediaCache = { resultId: latest.resultId, src: imageSrc, media, image, badge: null };
      }
      const { media, image } = mediaCache;
      const alt = actualPrompt.slice(0, 120);
      if (image.alt !== alt) image.alt = alt;
      if (size) {
        if (!mediaCache.badge) {
          mediaCache.badge = document.createElement('span');
          mediaCache.badge.className = 'stia-card__size';
          media.append(mediaCache.badge);
        }
        if (mediaCache.badge.textContent !== size) mediaCache.badge.textContent = size;
      } else if (mediaCache.badge) {
        mediaCache.badge.remove();
        mediaCache.badge = null;
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
        button(active ? '并行重 roll' : '重新生成', '', () => onGenerate(tag, 'manual'), '↻'),
        button('查看 / 保存', 'stia-button--square', openOriginal, '⌕'),
        button('画廊', 'stia-button--square', () => onOpenGallery(tag.tagId), '▦'),
      );
      if (canAdjust) {
        actions.append(button('调整后重绘', '', adjustRegenerate, '✎'));
      }
      body.append(completion, actions, details());
      if (active) body.append(pendingControls(activeAttempts, { showRoll: false }));
      if (media.parentNode === root) {
        // 同一张图仍在原位置：仅替换文字与按钮，图片不摘下、不重写 src。
        renderedBody.replaceWith(body);
      } else {
        root.replaceChildren(media, body);
      }
      renderedBody = body;
      renderedSignature = signature;
      return;
    }

    const body = document.createElement('div');
    body.className = 'stia-card__body';
    if (attempt && ['failed', 'interrupted', 'cancelled'].includes(attempt.status)) {
      root.classList.add('stia-card--failed');
      body.append(statusHeading(
        '×',
        attempt.status === 'failed' ? '生成失败' : STATUS_TEXT[attempt.status],
        attempt.errorMessage || '请稍后重试',
        'is-danger',
      ));
      const actions = document.createElement('div');
      actions.className = 'stia-actions stia-actions--fill';
      actions.append(button('重试', 'stia-button--danger-soft', () => {
        onGenerate(tag, 'manual');
      }, '↻'));
      if (canAdjust) actions.append(button('调整后重绘', '', adjustRegenerate, '✎'));
      if (onRemove) actions.append(removeButton());
      body.append(actions, details());
      root.append(body);
      renderedBody = body;
      renderedSignature = signature;
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
    const actions = document.createElement('div');
    actions.className = 'stia-actions stia-actions--fill';
    actions.append(button(attempt ? '重新生成' : '生成图片', 'stia-button--primary', () => {
      onGenerate(tag, 'manual');
    }, '▧'));
    if (onRemove) actions.append(removeButton());
    if (canAdjust && attempt) actions.append(button('调整后重绘', '', adjustRegenerate, '✎'));
    body.append(details(), actions);
    root.append(body);
    renderedBody = body;
    renderedSignature = signature;
  }

  return { root, render, updateTag(nextTag) { tag = nextTag; } };
}
