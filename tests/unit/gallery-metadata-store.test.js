import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GALLERY_METADATA_FILE,
  createGalleryMetadataStore,
  createSillyTavernGalleryMetadataStore,
} from '../../src/ui/api/gallery-metadata-store.js';

test('直连画廊通过 SillyTavern 用户文件接口读写独立 JSON', async () => {
  const calls = [];
  const store = createSillyTavernGalleryMetadataStore({
    headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
  }, async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).startsWith('/user/files/st-image-atelier-gallery.json?')) {
      return new Response('', { status: 404 });
    }
    if (url === '/api/files/upload') return new Response(JSON.stringify({ path: 'user/files/file.json' }));
    throw new Error(`Unexpected URL: ${url}`);
  });

  await store.initialize({
    legacyItems: [{
      resultId: 'legacy',
      status: 'available',
      prompt: 'old',
      promptSnapshot: 'actual',
      resolvedPrompt: 'resolved',
    }],
  });
  const upload = calls.find(call => call.url === '/api/files/upload');
  const body = JSON.parse(upload.options.body);
  assert.equal(body.name, GALLERY_METADATA_FILE);
  const written = JSON.parse(Buffer.from(body.data, 'base64').toString('utf8'));
  assert.equal(written.results.legacy.prompt, 'actual');
  assert.equal('promptSnapshot' in written.results.legacy, false);
  assert.equal('resolvedPrompt' in written.results.legacy, false);
});

test('临近的结果和进度合并写入，失败后仍可重新写入', async () => {
  const writes = [];
  let failNext = false;
  const store = createGalleryMetadataStore({
    readDocument: async () => null,
    writeDocument: async document => {
      if (failNext) {
        failNext = false;
        throw new Error('disk failed');
      }
      writes.push(structuredClone(document));
    },
    resultWriteDelayMs: 15,
  });
  await store.initialize();
  const one = { resultId: 'one', status: 'available', prompt: 'one', tagId: 'tag' };
  const two = { resultId: 'two', status: 'available', prompt: 'two', tagId: 'tag' };
  await Promise.all([
    store.putGeneration([one], { attemptId: 'a', tagId: 'tag', status: 'succeeded' }),
    store.putGeneration([two], { attemptId: 'b', tagId: 'tag', status: 'succeeded' }),
    store.putAttempts([{ attemptId: 'c', tagId: 'tag', status: 'downloading' }], { deferred: true }),
  ]);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].results).sort(), ['one', 'two']);
  assert.deepEqual(Object.keys(writes[0].attempts).sort(), ['a', 'b', 'c']);
  failNext = true;
  await assert.rejects(store.putGeneration([{
    resultId: 'failed', status: 'available', prompt: 'failure', tagId: 'tag',
  }], { attemptId: 'failed', tagId: 'tag' }), /disk failed/);
  assert.equal(store.has('failed'), false);
  await store.putGeneration([{
    resultId: 'recovered', status: 'available', prompt: 'retry', tagId: 'tag',
  }], { attemptId: 'recovered', tagId: 'tag' });
  assert.equal(store.has('failed'), false);
  assert.equal(store.has('recovered'), true);
});
