'use strict';

// A generation deadline is a reminder by default: the upstream may already
// have charged for a request and still return its image much later.
function startGenerationTimeout({ controller, timeoutMs, keepWaiting = false, onTimeout }) {
  const milliseconds = Number(timeoutMs);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return () => {};
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    if (!keepWaiting) {
      controller.abort(new Error('timeout'));
      return;
    }
    Promise.resolve().then(() => {
      if (!controller.signal.aborted) return onTimeout?.(milliseconds);
    }).catch(error => {
      console.warn('[画笺] 无法更新等待状态', error);
    });
  }, milliseconds);
  return () => clearTimeout(timer);
}

function generationWaitMessage(timeoutMs) {
  return `已等待超过 ${Math.round(timeoutMs / 1000)} 秒，仍在等待上游返回；可换 Key 后并行重 roll，原请求会继续接图`;
}

module.exports = { startGenerationTimeout, generationWaitMessage };
