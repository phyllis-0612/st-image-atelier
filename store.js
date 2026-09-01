export function createStore() {
  const listeners = new Set();
  const state = {
    health: null,
    settings: { enabled: true, autoGenerate: false, generationProvider: 'openai' },
    preset: null,
    novelAi: null,
    artistPreset: null,
    tagStates: new Map(),
    serviceError: null,
  };

  function emit() {
    for (const listener of listeners) listener(state);
  }

  return {
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(patch) {
      Object.assign(state, patch);
      emit();
    },
    setTag(tagId, value) {
      state.tagStates.set(tagId, value);
      emit();
    },
  };
}
