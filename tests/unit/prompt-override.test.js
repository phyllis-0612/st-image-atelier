import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  createPromptOverrideDialog,
  validatePromptOverride,
} from '../../src/ui/pages/prompt-override/prompt-override.js';
import { createCard } from '../../src/ui/renderer/card.js';

function withDom(t) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    dom.window.close();
  });
  return dom;
}

test('临时提示词校验非空与 20000 字符上限', () => {
  assert.throws(() => validatePromptOverride('   '), /不能为空/);
  assert.throws(() => validatePromptOverride('x'.repeat(20_001)), /20000/);
  assert.throws(() => validatePromptOverride('ok', 'x'.repeat(20_001)), /20000/);
  assert.deepEqual(validatePromptOverride('  new prompt  ', '  bad hands  '), {
    prompt: 'new prompt',
    negativePrompt: 'bad hands',
  });
});

test('弹窗取消不提交；NovelAI 显示并提交临时负面提示词', async t => {
  withDom(t);
  const dialog = createPromptOverrideDialog();
  const cancelled = dialog.open({ prompt: 'old prompt' });
  dialog.root.querySelector('button').click();
  assert.equal(await cancelled, null);

  const submitted = dialog.open({
    prompt: 'old prompt',
    negativePrompt: 'old negative',
    provider: 'novelai',
  });
  const textareas = dialog.root.querySelectorAll('textarea');
  assert.equal(textareas[1].closest('label').hidden, false);
  textareas[0].value = 'next prompt';
  textareas[1].value = 'next negative';
  [...dialog.root.querySelectorAll('button')]
    .find(button => button.textContent === '用此提示词生成').click();
  assert.deepEqual(await submitted, { prompt: 'next prompt', negativePrompt: 'next negative' });
});

test('调整后重绘入口受总开关控制，并以上次实际提示词快照为起点', t => {
  withDom(t);
  const tag = { tagId: 'tag', prompt: 'original prompt' };
  const state = {
    tag: { latestResultId: 'result' },
    attempts: [{ attemptId: 'attempt', status: 'succeeded', provider: 'novelai' }],
    results: [{
      resultId: 'result',
      status: 'available',
      provider: 'novelai',
      promptSnapshot: 'last actual prompt',
      negativePromptSnapshot: 'last actual negative',
    }],
  };
  const contexts = [];
  const settings = { enablePromptOverrideRegenerate: false };
  const card = createCard({
    tag,
    api: { fileUrl: () => '/image.png' },
    getState: () => state,
    getSettings: () => settings,
    onGenerate() {},
    onOpenGallery() {},
    onCancel() {},
    onAdjustRegenerate: (_tag, context) => contexts.push(context),
  });
  card.render();
  assert.equal(card.root.textContent.includes('调整后重绘'), false);
  settings.enablePromptOverrideRegenerate = true;
  card.render();
  [...card.root.querySelectorAll('button')]
    .find(button => button.textContent.includes('调整后重绘')).click();
  assert.equal(contexts[0].prompt, 'last actual prompt');
  assert.equal(contexts[0].negativePrompt, 'last actual negative');
});
