export const ACTIVE_STATUSES = new Set(['queued', 'generating', 'downloading', 'saving']);

// History queries may have started before a local generation/progress update.
export function mergeResolvedTagState(current, resolved, snapshot) {
  if (!current) return resolved;
  if (current !== snapshot) return current;
  const incoming = new Map((resolved.attempts || []).map(attempt => [attempt.attemptId, attempt]));
  for (const attempt of current.attempts || []) {
    const remote = incoming.get(attempt.attemptId);
    if (ACTIVE_STATUSES.has(attempt.status) && (!remote || ACTIVE_STATUSES.has(remote.status))) {
      incoming.set(attempt.attemptId, attempt);
    }
  }
  return { ...resolved, attempts: [...incoming.values()] };
}

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
