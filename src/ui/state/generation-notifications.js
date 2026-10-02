import { MAX_GENERATION_RETRIES } from '../../shared/generation-retry.js';

export function createGenerationNotifications(notify) {
  let lastRetryCount = 0;
  let failureNotified = false;
  return {
    progress(attempt) {
      if (!['queued', 'generating'].includes(attempt?.status)) return;
      const retry = attempt.retryNotice;
      if (!retry || retry.retryCount <= lastRetryCount) return;
      lastRetryCount = retry.retryCount;
      notify('warning', retry.message, '画笺 · 生图失败');
    },
    failed(error, retryCount = 0) {
      if (failureNotified) return;
      failureNotified = true;
      const reason = String(error?.errorMessage || error?.message || '生成失败').slice(0, 300);
      const stopped = retryCount >= MAX_GENERATION_RETRIES
        ? `自动重试已达 ${MAX_GENERATION_RETRIES} 次，已停止。可在消息末尾手动重试。`
        : '可在消息末尾查看详情并手动重试。';
      notify('error', `${reason}；${stopped}`, '画笺 · 生图失败');
    },
  };
}
