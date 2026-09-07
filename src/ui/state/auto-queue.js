export function createAutoQueue(generate) {
  const queue = [];
  const pending = new Set();
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    while (queue.length) {
      const tag = queue.shift();
      try {
        await generate(tag, 'auto');
      } catch (error) {
        console.warn('[Image Atelier] 自动生图失败，不会自动重试', error);
      } finally {
        pending.delete(tag.tagId);
      }
    }
    running = false;
  }

  return {
    enqueue(tag) {
      if (pending.has(tag.tagId)) return false;
      pending.add(tag.tagId);
      queue.push(tag);
      void drain();
      return true;
    },
  };
}
