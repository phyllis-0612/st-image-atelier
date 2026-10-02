export const MAX_GENERATION_RETRIES = 3;

export function canRetryGeneration(error) {
  const reason = `${error?.message || ''} ${error?.details || ''}`;
  if (/moderation|content (?:was )?rejected|safety|content policy|quota|balance|credits?|billing|insufficient|内容审核|安全策略|余额|配额|额度|欠费/i.test(reason)) return false;
  if (!error?.retryable) return false;
  return ['UPSTREAM_HTTP_ERROR', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_TIMEOUT', 'DIRECT_FETCH_BLOCKED'].includes(error.code);
}

export function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('cancelled'));
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason || new Error('cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// Parameter recovery and transient failures share one budget: at most four requests.
export async function runGenerationWithRetry({
  request, enabled = false, signal, recover, onRetry,
  retryDelays = [1500, 3000, 6000],
}) {
  let retryCount = 0;
  for (;;) {
    if (signal?.aborted) throw signal.reason || new Error('cancelled');
    try {
      return await request();
    } catch (error) {
      error.autoRetryCount = retryCount;
      if (!enabled || signal?.aborted || retryCount >= MAX_GENERATION_RETRIES) throw error;
      const recovery = await recover?.(error);
      if (!recovery && !canRetryGeneration(error)) throw error;
      retryCount += 1;
      const delayMs = recovery ? 0 : (retryDelays[retryCount - 1] ?? 6000);
      await onRetry?.({
        retryCount, maxRetries: MAX_GENERATION_RETRIES, delayMs,
        errorCode: error.code,
        message: `${recovery?.reason || '生成失败'}，正在自动重试（${retryCount}/${MAX_GENERATION_RETRIES}）`,
      });
      await waitForRetry(delayMs, signal);
    }
  }
}
