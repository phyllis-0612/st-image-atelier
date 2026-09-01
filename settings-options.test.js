import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_SIZE_OPTIONS } from '../../src/ui/pages/settings/settings.js';

test('常用尺寸选项包含 512x768，且使用接口兼容格式', () => {
  const values = IMAGE_SIZE_OPTIONS.map(([value]) => value);
  assert.equal(values.length, new Set(values).size);
  assert.ok(values.includes('512x768'));
  assert.ok(values.includes('768x512'));
  assert.ok(values.includes('576x1024'));
  assert.ok(values.includes('1024x576'));
  assert.ok(values.length >= 20);
  for (const value of values.filter(item => item !== 'auto')) {
    assert.match(value, /^\d+x\d+$/);
  }
});
