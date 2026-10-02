export const ACTIVE_STATUSES = new Set(['queued', 'generating', 'downloading', 'saving']);

// Progress from an older request must not move it ahead of a newer roll.
export function upsertAttempt(state, attempt) {
  const attempts = state.attempts || [];
  return {
    ...state,
    attempts: attempts.some(item => item.attemptId === attempt.attemptId)
      ? attempts.map(item => item.attemptId === attempt.attemptId ? attempt : item)
      : [attempt, ...attempts],
  };
}
