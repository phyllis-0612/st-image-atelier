import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  THEME_PALETTES,
  applyThemeMode,
  normalizeThemeMode,
} from '../../src/ui/theme/theme.js';

function luminance(hex) {
  const components = hex.slice(1).match(/.{2}/g).map(value => Number.parseInt(value, 16) / 255);
  const linear = components.map(value => value <= 0.03928
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(left, right) {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('主题值可规范化并应用到页面根节点', () => {
  const root = { dataset: {} };
  assert.equal(applyThemeMode('light', root), 'light');
  assert.equal(root.dataset.stiaTheme, 'light');
  assert.equal(normalizeThemeMode('unknown'), 'tavern');
  assert.equal(applyThemeMode('unknown', root), 'tavern');
  assert.equal(root.dataset.stiaTheme, 'tavern');
});

test('日夜主题输入框文字满足 WCAG AA 对比度且写入样式表', async () => {
  const cssFile = fileURLToPath(new URL('../../src/ui/styles/atelier.css', import.meta.url));
  const css = await fs.readFile(cssFile, 'utf8');
  for (const [mode, palette] of Object.entries(THEME_PALETTES)) {
    assert.ok(contrast(palette.input, palette.inputText) >= 4.5, `${mode} 输入框对比度不足`);
    assert.match(css, new RegExp(`data-stia-theme=["']${mode}["']`));
    assert.ok(css.includes(`--stia-input: ${palette.input}`));
    assert.ok(css.includes(`--stia-input-text: ${palette.inputText}`));
  }
  assert.match(css, /color:\s*var\(--stia-input-text\)/);
});
