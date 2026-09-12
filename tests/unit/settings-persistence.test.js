import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createToolPanel } from '../../src/ui/pages/settings/settings.js';
import { createStore } from '../../src/ui/state/store.js';

function clone(value) {
  return structuredClone(value);
}

async function waitFor(predicate, message) {
  for (let index = 0; index < 40; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('总开关即时持久化，独立保存生图参数后立即更新当前预设', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://tavern.example/',
  });
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    navigator: globalThis.navigator,
    confirm: globalThis.confirm,
  };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.confirm = () => true;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator });
    globalThis.confirm = previous.confirm;
    dom.window.close();
  });

  let settings = {
    enabled: true,
    autoGenerate: false,
    enablePromptOverrideRegenerate: false,
    enableSmartRetry: false,
    generationProvider: 'openai',
    executionMode: 'direct',
    themeMode: 'tavern',
    allowHttp: false,
  };
  let preset = {
    id: 'default',
    name: '主站 API',
    baseUrl: 'https://api.example.com',
    modelsPath: '/v1/models',
    generationPath: '/v1/images/generations',
    selectedModel: 'gpt-image-1',
    cachedModels: [{ id: 'gpt-image-1' }],
    defaultSize: '1024x1024',
    defaultQuality: 'auto',
    defaultCount: 1,
    sendSize: true,
    sendQuality: true,
    sendN: true,
    timeoutMs: 180000,
    responseFormat: 'b64_json',
    extraBody: {},
    hasApiKey: true,
    apiKeyMask: 'sk-••••demo',
  };
  const settingsPatches = [];
  const presetPatches = [];
  const api = {
    mode: () => settings.executionMode,
    health: async () => ({ mode: settings.executionMode }),
    getSettings: async () => clone(settings),
    updateSettings: async patch => {
      settingsPatches.push(clone(patch));
      settings = { ...settings, ...patch };
      return clone(settings);
    },
    getPresets: async () => ({ activePresetId: preset.id, items: [clone(preset)] }),
    updatePreset: async (_id, patch) => {
      presetPatches.push(clone(patch));
      preset = { ...preset, ...patch };
      return clone(preset);
    },
    getNovelAi: async () => ({
      config: {
        baseUrl: '', model: 'nai-diffusion-4-5-full', sampler: 'k_euler',
        defaultSize: '832x1216', defaultCount: 1, steps: 28, scale: 5,
      },
      artistPresets: [{ id: 'default', name: '默认画师串', prompt: '', negativePrompt: '' }],
      activeArtistPresetId: 'default',
    }),
    cleanupGallery: async () => ({}),
    galleryMetadata: async () => ({ items: [] }),
    fileUrl: id => `/images/${id}`,
  };
  const store = createStore();
  const panel = createToolPanel({ api, store });
  panel.show();

  await waitFor(() => store.state.preset?.id === 'default', '设置面板未完成初始化');
  const labels = () => [...document.querySelectorAll('.stia-settings-page label')];
  const controlFor = text => labels().find(label => label.textContent.includes(text))?.querySelector('input, select');

  const enabled = controlFor('扩展已启用');
  enabled.checked = false;
  enabled.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await waitFor(() => settingsPatches.some(patch => patch.enabled === false), '总开关没有立即写入设置');
  assert.equal(settings.enabled, false);
  assert.equal(store.state.settings.enabled, false);

  await panel.load();
  assert.equal(enabled.checked, false, '重新打开设置后不应反弹为开启');

  const size = controlFor('默认尺寸');
  const quality = controlFor('默认质量');
  const count = controlFor('默认数量');
  size.value = '512x768';
  quality.value = 'high';
  count.value = '2';
  for (const control of [size, quality, count]) {
    control.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  }
  assert.match(document.querySelector('.stia-settings-page').textContent, /参数已修改/);

  const saveParameters = [...document.querySelectorAll('button')]
    .find(button => button.textContent.includes('保存生图参数'));
  saveParameters.click();
  await waitFor(() => presetPatches.some(patch => patch.defaultSize === '512x768'), '生图参数没有独立保存');
  assert.deepEqual(presetPatches.at(-1), {
    defaultSize: '512x768',
    defaultQuality: 'high',
    defaultCount: 2,
    sendSize: true,
    sendQuality: true,
    sendN: true,
  });
  assert.equal(store.state.preset.defaultSize, '512x768');
  assert.equal(store.state.preset.defaultQuality, 'high');
  assert.equal(store.state.preset.defaultCount, 2);

  await panel.load();
  assert.equal(size.value, '512x768');
  assert.equal(quality.value, 'high');
  assert.equal(count.value, '2');
});
