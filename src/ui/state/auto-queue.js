export function createAutoQueue(generate) {
  const queue = [];
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
      }
    }
    running = false;
  }

  return {
    enqueue(tag) {
      if (queue.some(item => item.tagId === tag.tagId)) return;
      queue.push(tag);
      void drain();
    },
  };
}
