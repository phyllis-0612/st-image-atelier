import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIST_PRESET_EXPORT_FORMAT,
  createArtistPresetExport,
  parseArtistPresetImport,
} from '../../src/ui/api/artist-preset-transfer.js';

test('画师串导出只包含可分享的正负面配置', () => {
  const payload = createArtistPresetExport([
    { id: 'private-id', name: '空预设', prompt: '', negativePrompt: '' },
    {
      id: 'artist-id',
      name: '柔光',
      prompt: 'artist:a, soft light',
      negativePrompt: 'bad anatomy',
      apiKey: 'must-not-export',
      createdAt: 'private-time',
    },
  ], { exportedAt: '2026-09-01T00:00:00.000Z' });

  assert.equal(payload.format, ARTIST_PRESET_EXPORT_FORMAT);
  assert.equal(payload.version, 1);
  assert.deepEqual(payload.presets, [{
    name: '柔光',
    positivePrompt: 'artist:a, soft light',
    negativePrompt: 'bad anatomy',
  }]);
  assert.doesNotMatch(JSON.stringify(payload), /private-id|must-not-export|private-time/);
});

test('画师串导入兼容分享格式、数组与常见字段别名', () => {
  assert.deepEqual(parseArtistPresetImport({
    format: ARTIST_PRESET_EXPORT_FORMAT,
    version: 1,
    presets: [{ name: 'A', positivePrompt: 'pos', negativePrompt: 'neg' }],
  }), [{ name: 'A', prompt: 'pos', negativePrompt: 'neg' }]);

  assert.deepEqual(parseArtistPresetImport([
    { title: 'B', prompt: 'p2', negative_prompt: 'n2' },
    { name: 'C', uc: 'n3' },
  ]), [
    { name: 'B', prompt: 'p2', negativePrompt: 'n2' },
    { name: 'C', prompt: '', negativePrompt: 'n3' },
  ]);
});

test('画师串导入拒绝错误格式、未来版本与空配置', () => {
  assert.throws(() => parseArtistPresetImport({ format: 'other', presets: [] }), /不是/);
  assert.throws(() => parseArtistPresetImport({
    format: ARTIST_PRESET_EXPORT_FORMAT,
    presets: [{ prompt: 'x' }],
  }), /版本无效/);
  assert.throws(() => parseArtistPresetImport({
    format: ARTIST_PRESET_EXPORT_FORMAT,
    version: 99,
    presets: [{ prompt: 'x' }],
  }), /更高版本/);
  assert.throws(() => parseArtistPresetImport([{ name: 'empty' }]), /都为空/);
});
