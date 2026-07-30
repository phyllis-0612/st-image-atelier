const STATUS_TEXT = {
  queued: '排队中',
  generating: '正在生成',
  downloading: '正在下载',
  saving: '正在保存',
  interrupted: '生成被中断',
  cancelled: '已取消',
};

function button(label, className, action, disabled = false) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `stia-button ${className || ''}`.trim();
  element.textContent = label;
  element.disabled = disabled;
  element.addEventListener('click', action);
  return element;
}

function detailsPrompt(prompt) {
  const details = document.createElement('details');
  details.className = 'stia-prompt';
  const summary = document.createElement('summary');
  summary.textContent = '查看提示词';
  const text = document.createElement('pre');
  text.textContent = prompt;
  details.append(summary, text);
  return details;
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
    const latest = available.find(result => result.resultId === state.tag?.latestResultId) || available.at(-1);
    root.replaceChildren();

    const header = document.createElement('div');
    header.className = 'stia-card__header';
    const title = document.createElement('strong');
    title.textContent = '✦ Image Atelier';
    const model = document.createElement('span');
    model.className = 'stia-muted';
    model.textContent = attempt?.model || '等待配置模型';
    header.append(title, model);
    root.append(header);

    if (latest) {
      const image = document.createElement('img');
      image.className = 'stia-card__image';
      image.src = api.fileUrl(latest.resultId);
      image.alt = tag.prompt.slice(0, 120);
      image.loading = 'lazy';
      root.append(image);
      const actions = document.createElement('div');
      actions.className = 'stia-actions';
      actions.append(
        button('重新生成', 'stia-button--primary', () => onGenerate(tag, 'manual')),
        button('下载', '', () => {
          const anchor = document.createElement('a');
          anchor.href = api.downloadUrl(latest.resultId);
          anchor.download = '';
          anchor.click();
        }),
        button(`历史 ${available.length} 张`, '', () => onOpenGallery(tag.tagId)),
      );
      root.append(actions);
    } else if (attempt && ['queued', 'generating', 'downloading', 'saving'].includes(attempt.status)) {
      const progress = document.createElement('div');
      progress.className = 'stia-progress';
      progress.setAttribute('role', 'status');
      progress.textContent = `◌ ${STATUS_TEXT[attempt.status] || '处理中'}`;
      root.append(progress);
      const actions = document.createElement('div');
      actions.className = 'stia-actions';
      actions.append(button('取消', '', () => onCancel(attempt.attemptId)));
      root.append(actions);
    } else {
      if (attempt && ['failed', 'interrupted', 'cancelled'].includes(attempt.status)) {
        const error = document.createElement('p');
        error.className = 'stia-error';
        error.textContent = attempt.errorMessage || STATUS_TEXT[attempt.status] || '生成失败';
        root.append(error);
      } else if (state.tag?.resultIds?.length) {
        const deleted = document.createElement('p');
        deleted.className = 'stia-muted';
        deleted.textContent = '图片已删除，可重新生成';
        root.append(deleted);
      }
      const actions = document.createElement('div');
      actions.className = 'stia-actions';
      actions.append(button(
        attempt ? '重试' : '生成图片',
        'stia-button--primary',
        () => onGenerate(tag, 'manual'),
      ));
      root.append(actions);
    }
    root.append(detailsPrompt(tag.prompt));
  }

  return { root, render };
}
