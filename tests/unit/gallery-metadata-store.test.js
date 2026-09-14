import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GALLERY_METADATA_FILE,
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
