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

test('生图参数下拉自带「不发送」选项，值为空串以便直接映射 sendSize / sendQuality / sendN', async () => {
  const { SKIP_PARAM_OPTION } = await import('../../src/ui/pages/settings/settings.js');
  assert.equal(SKIP_PARAM_OPTION[0], '');
  assert.ok(/不发送/.test(SKIP_PARAM_OPTION[1]));
  assert.ok(!IMAGE_SIZE_OPTIONS.some(([value]) => value === ''), '尺寸列表本身不含空值，空值只由下拉层加入');
});
