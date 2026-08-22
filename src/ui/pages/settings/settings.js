import { createGalleryPage } from '../gallery/gallery.js';
import {
  NOVELAI_MODELS,
  NOVELAI_SAMPLERS,
  normalizeNovelAiEndpoint,
} from '../../api/novelai-direct.js';

export const IMAGE_SIZE_OPTIONS = Object.freeze([
  ['auto', 'auto（由模型决定）'],
  ['256x256', '256 × 256（方图）'],
  ['512x512', '512 × 512（方图）'],
  ['640x640', '640 × 640（方图）'],
  ['768x768', '768 × 768（方图）'],
  ['1024x1024', '1024 × 1024（方图）'],
  ['512x768', '512 × 768（竖图 2:3）'],
  ['512x1024', '512 × 1024（竖图 1:2）'],
  ['576x1024', '576 × 1024（竖图 9:16）'],
  ['768x1024', '768 × 1024（竖图 3:4）'],
  ['768x1152', '768 × 1152（竖图 2:3）'],
  ['832x1216', '832 × 1216（竖图）'],
  ['896x1152', '896 × 1152（竖图）'],
  ['1024x1536', '1024 × 1536（竖图 2:3）'],
  ['1024x1792', '1024 × 1792（竖图）'],
  ['768x512', '768 × 512（横图 3:2）'],
  ['1024x512', '1024 × 512（横图 2:1）'],
  ['1024x576', '1024 × 576（横图 16:9）'],
  ['1024x768', '1024 × 768（横图 4:3）'],
  ['1152x768', '1152 × 768（横图 3:2）'],
  ['1216x832', '1216 × 832（横图）'],
  ['1152x896', '1152 × 896（横图）'],
  ['1536x1024', '1536 × 1024（横图 3:2）'],
  ['1792x1024', '1792 × 1024（横图）'],
]);

function field(labelText, control) {
  const label = document.createElement('label');
  label.className = 'stia-field';
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

function input(type = 'text') {
  const element = document.createElement('input');
  element.type = type;
  return element;
}

function select(options = []) {
  const element = document.createElement('select');
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    element.append(option);
  }
  return element;
}

function action(label, handler, primary = false) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `stia-button${primary ? ' stia-button--primary' : ''}`;
  element.textContent = label;
  element.addEventListener('click', handler);
  return element;
}

export function createToolPanel({ api, store }) {
  const overlay = document.createElement('div');
  overlay.className = 'stia-overlay';
  overlay.hidden = true;
  const panel = document.createElement('section');
  panel.className = 'stia-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Image Atelier 工具窗口');

  const header = document.createElement('header');
  const heading = document.createElement('h2');
  heading.textContent = 'Image Atelier';
  const health = document.createElement('span');
  health.className = 'stia-health';
  health.textContent = '正在连接…';
  const close = action('×', () => hide());
  close.className = 'stia-icon-button';
  close.setAttribute('aria-label', '关闭');
  header.append(heading, health, close);

  const tabs = document.createElement('nav');
  tabs.className = 'stia-tabs';
  const settingsTab = action('设置', () => showTab('settings'), true);
  const galleryTab = action('画廊', () => showTab('gallery'));
  tabs.append(settingsTab, galleryTab);

  const settingsPage = document.createElement('section');
  settingsPage.className = 'stia-settings-page';
  const gallery = createGalleryPage(api);
  gallery.root.hidden = true;

  const enabled = input('checkbox');
  const autoGenerate = input('checkbox');
  const executionMode = select([
    ['direct', '免服务端直连（推荐，一键安装）'],
    ['server', 'Server Plugin 增强模式'],
  ]);
  const allowHttp = input('checkbox');
  const generationProvider = input('hidden');
  generationProvider.value = 'openai';
  const presetSelector = select();
  presetSelector.setAttribute('aria-label', '选择 API 预设');
  const presetName = input();
  presetName.placeholder = '例如：主站 API、备用 API';
  const baseUrl = input('url');
  baseUrl.placeholder = 'https://api.example.com';
  const apiKey = input('password');
  apiKey.placeholder = '留空则保留当前预设的密钥';
  apiKey.autocomplete = 'new-password';
  const model = select([['', '请先拉取模型']]);
  const modelsPath = input();
  modelsPath.placeholder = '/v1/models';
  const generationPath = input();
  generationPath.placeholder = '/v1/images/generations';
  const defaultSize = select(IMAGE_SIZE_OPTIONS);
  const defaultQuality = select([
    ['auto', 'auto'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['standard', 'standard'],
    ['hd', 'hd'],
  ]);
  const defaultCount = select([
    ['1', '1 张'],
    ['2', '2 张'],
    ['3', '3 张'],
    ['4', '4 张'],
  ]);
  const timeout = input('number');
  timeout.min = '30';
  timeout.max = '600';
  const extraBody = document.createElement('textarea');
  extraBody.rows = 4;
  extraBody.placeholder = '{"background":"transparent"}';
  const sendSize = input('checkbox');
  const sendQuality = input('checkbox');
  const sendN = input('checkbox');

  const novelAiBaseUrl = input('url');
  novelAiBaseUrl.placeholder = '例如：https://中转站/api（填 /api/v1 也会自动兼容）';
  const novelAiGenerationPath = input();
  novelAiGenerationPath.placeholder = '/ai/generate-image';
  const novelAiKey = input('password');
  novelAiKey.placeholder = '留空则保留当前中转站 Key / NAI Token';
  novelAiKey.autocomplete = 'new-password';
  const novelAiModel = select(NOVELAI_MODELS.map(item => [item.id, item.label]));
  const novelAiSampler = select(NOVELAI_SAMPLERS);
  const novelAiSchedule = select([
    ['karras', 'Karras'],
    ['native', 'Native'],
    ['exponential', 'Exponential'],
    ['polyexponential', 'Polyexponential'],
  ]);
  const novelAiSize = select(IMAGE_SIZE_OPTIONS.filter(([value]) => value !== 'auto'));
  const novelAiCount = select([
    ['1', '1 张'],
    ['2', '2 张'],
    ['3', '3 张'],
    ['4', '4 张'],
  ]);
  const novelAiSteps = input('number');
  novelAiSteps.min = '1';
  novelAiSteps.max = '50';
  const novelAiScale = input('number');
  novelAiScale.min = '0';
  novelAiScale.max = '20';
  novelAiScale.step = '0.1';
  const novelAiCfgRescale = input('number');
  novelAiCfgRescale.min = '0';
  novelAiCfgRescale.max = '1';
  novelAiCfgRescale.step = '0.01';
  const novelAiSeed = input('number');
  novelAiSeed.min = '-1';
  novelAiSeed.placeholder = '-1 表示随机';
  const novelAiTimeout = input('number');
  novelAiTimeout.min = '30';
  novelAiTimeout.max = '600';
  const novelAiNegative = document.createElement('textarea');
  novelAiNegative.rows = 4;
  novelAiNegative.placeholder = '不希望画面中出现的内容，可留空';
  const novelAiQualityTags = input('checkbox');
  const novelAiSmea = input('checkbox');
  const novelAiSmeaDyn = input('checkbox');
  const novelAiVariety = input('checkbox');

  const artistSelector = select();
  artistSelector.setAttribute('aria-label', '选择画师串预设');
  const artistName = input();
  artistName.placeholder = '例如：柔光厚涂、赛璐璐';
  const artistPrompt = document.createElement('textarea');
  artistPrompt.rows = 4;
  artistPrompt.placeholder = '输入画师标签或风格串；生成时会自动放在正文提示词前';
  const status = document.createElement('p');
  status.className = 'stia-status';
  status.setAttribute('role', 'status');
  const urlPreview = document.createElement('code');
  urlPreview.className = 'stia-url-preview';
  const novelAiUrlPreview = document.createElement('code');
  novelAiUrlPreview.className = 'stia-url-preview';
  let presets = [];
  let activePresetId = '';
  let artistPresets = [];
  let activeArtistPresetId = '';
  let novelAiConfig = null;
  let openAiExecutionMode = 'direct';

  function normalizePreview() {
    try {
      const url = new URL(baseUrl.value);
      const baseParts = url.pathname.split('/').filter(Boolean);
      const route = String(generationPath.value || '/v1/images/generations')
        .split('/')
        .filter(Boolean);
      if (baseParts.at(-1)?.toLowerCase() === 'v1' && route[0]?.toLowerCase() === 'v1') {
        route.shift();
      }
      url.pathname = `/${[...baseParts, ...route].join('/')}`;
      urlPreview.textContent = url.toString();
    } catch {
      urlPreview.textContent = '填写 Base URL 后显示最终请求地址';
    }
  }
  baseUrl.addEventListener('input', normalizePreview);
  generationPath.addEventListener('input', normalizePreview);

  function normalizeNovelAiPreview() {
    try {
      novelAiUrlPreview.textContent = normalizeNovelAiEndpoint(
        novelAiBaseUrl.value,
        novelAiGenerationPath.value || '/ai/generate-image',
      );
    } catch {
      novelAiUrlPreview.textContent = '填写 NAI 中转站或兼容站地址后显示最终请求地址';
    }
  }
  novelAiBaseUrl.addEventListener('input', normalizeNovelAiPreview);
  novelAiGenerationPath.addEventListener('input', normalizeNovelAiPreview);

  async function run(control, operation) {
    control.disabled = true;
    status.className = 'stia-status';
    status.textContent = '处理中…';
    try {
      await operation();
    } catch (error) {
      status.className = 'stia-status stia-error';
      status.textContent = error.message;
    } finally {
      control.disabled = false;
    }
  }

  function updateModelList(models, selectedValue = '') {
    const values = (models || []).map(item => item.id).filter(Boolean);
    if (selectedValue && !values.includes(selectedValue)) values.unshift(selectedValue);
    model.replaceChildren();
    if (!values.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '请先拉取模型';
      model.append(option);
      return;
    }
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value === selectedValue && !(models || []).some(item => item.id === value)
        ? `${value}（已保存）`
        : value;
      model.append(option);
    }
    model.value = selectedValue && values.includes(selectedValue) ? selectedValue : values[0];
  }

  function setSelectValue(control, value, label = value) {
    const normalized = String(value || '').replace(/(\d)\s*[×✕✖＊*X]\s*(\d)/g, '$1x$2');
    if (normalized && ![...control.options].some(option => option.value === normalized)) {
      const option = document.createElement('option');
      option.value = normalized;
      option.textContent = label;
      control.append(option);
    }
    control.value = normalized;
  }

  function updateArtistSelector(activeId = activeArtistPresetId) {
    artistSelector.replaceChildren();
    for (const preset of artistPresets) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      artistSelector.append(option);
    }
    artistSelector.value = activeId;
  }

  function loadArtistFields(preset) {
    if (!preset) return;
    activeArtistPresetId = preset.id;
    artistSelector.value = preset.id;
    artistName.value = preset.name || '';
    artistPrompt.value = preset.prompt || '';
  }

  function loadNovelAiFields(config) {
    if (!config) return;
    novelAiConfig = config;
    novelAiBaseUrl.value = config.baseUrl || '';
    novelAiGenerationPath.value = config.generationPath || '/ai/generate-image';
    novelAiKey.value = '';
    novelAiKey.placeholder = config.hasApiKey
      ? `当前已保存：${config.apiKeyMask}`
      : '当前尚未保存中转站 Key / NAI Token';
    setSelectValue(novelAiModel, config.model || 'nai-diffusion-4-5-full');
    setSelectValue(novelAiSampler, config.sampler || 'k_euler');
    setSelectValue(novelAiSchedule, config.noiseSchedule || 'karras');
    setSelectValue(
      novelAiSize,
      config.defaultSize || '832x1216',
      String(config.defaultSize || '832x1216').replace(/x/gi, ' × '),
    );
    setSelectValue(novelAiCount, String(config.defaultCount || 1), `${config.defaultCount || 1} 张`);
    novelAiSteps.value = String(config.steps ?? 28);
    novelAiScale.value = String(config.scale ?? 5);
    novelAiCfgRescale.value = String(config.cfgRescale ?? 0);
    novelAiSeed.value = String(config.seed ?? -1);
    novelAiTimeout.value = String(Math.round((config.timeoutMs || 180000) / 1000));
    novelAiNegative.value = config.negativePrompt || '';
    novelAiQualityTags.checked = config.qualityTags !== false;
    novelAiSmea.checked = Boolean(config.smea);
    novelAiSmeaDyn.checked = Boolean(config.smeaDyn);
    novelAiVariety.checked = config.variety !== false;
    syncNovelAiModelControls();
    normalizeNovelAiPreview();
  }

  function syncNovelAiModelControls() {
    const isV3 = novelAiModel.value === 'nai-diffusion-3';
    novelAiSmea.disabled = !isV3;
    novelAiSmeaDyn.disabled = !isV3 || !novelAiSmea.checked;
  }

  async function saveCurrentArtistPreset(presetId = activeArtistPresetId) {
    if (!presetId) throw new Error('没有可保存的画师串预设');
    const preset = await api.updateArtistPreset(presetId, {
      name: artistName.value.trim() || '未命名画师串',
      prompt: artistPrompt.value.trim(),
    });
    const index = artistPresets.findIndex(item => item.id === preset.id);
    if (index >= 0) artistPresets[index] = preset;
    else artistPresets.push(preset);
    updateArtistSelector(preset.id);
    loadArtistFields(preset);
    return preset;
  }

  async function saveNovelAiConfig() {
    const config = await api.updateNovelAi({
      baseUrl: novelAiBaseUrl.value.trim(),
      generationPath: novelAiGenerationPath.value.trim() || '/ai/generate-image',
      apiKey: novelAiKey.value,
      model: novelAiModel.value,
      sampler: novelAiSampler.value,
      noiseSchedule: novelAiSchedule.value,
      defaultSize: novelAiSize.value,
      defaultCount: Number(novelAiCount.value),
      steps: Number(novelAiSteps.value),
      scale: Number(novelAiScale.value),
      cfgRescale: Number(novelAiCfgRescale.value),
      seed: Number(novelAiSeed.value),
      timeoutMs: Number(novelAiTimeout.value) * 1000,
      negativePrompt: novelAiNegative.value.trim(),
      qualityTags: novelAiQualityTags.checked,
      smea: novelAiSmea.checked,
      smeaDyn: novelAiSmeaDyn.checked,
      variety: novelAiVariety.checked,
    });
    novelAiKey.value = '';
    novelAiKey.placeholder = config.hasApiKey
      ? `当前已保存：${config.apiKeyMask}`
      : '当前尚未保存中转站 Key / NAI Token';
    novelAiConfig = config;
    return config;
  }

  function loadPresetFields(preset) {
    if (!preset) return;
    activePresetId = preset.id;
    presetSelector.value = preset.id;
    presetName.value = preset.name || '';
    baseUrl.value = preset.baseUrl || '';
    modelsPath.value = preset.modelsPath || '/v1/models';
    generationPath.value = preset.generationPath || '/v1/images/generations';
    setSelectValue(
      defaultSize,
      preset.defaultSize || '1024x1024',
      String(preset.defaultSize || '1024x1024').replace(/x/gi, ' × '),
    );
    setSelectValue(defaultQuality, preset.defaultQuality || 'auto');
    setSelectValue(defaultCount, String(preset.defaultCount || 1), `${preset.defaultCount || 1} 张`);
    timeout.value = String(Math.round((preset.timeoutMs || 180000) / 1000));
    extraBody.value = JSON.stringify(preset.extraBody || {}, null, 2);
    sendSize.checked = preset.sendSize !== false;
    sendQuality.checked = preset.sendQuality !== false;
    sendN.checked = preset.sendN !== false;
    apiKey.value = '';
    apiKey.placeholder = preset.hasApiKey
      ? `当前预设已保存：${preset.apiKeyMask}`
      : '当前预设尚未保存密钥';
    updateModelList(preset.cachedModels, preset.selectedModel);
    normalizePreview();
  }

  function updatePresetSelector(activeId = activePresetId) {
    presetSelector.replaceChildren();
    for (const preset of presets) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      presetSelector.append(option);
    }
    presetSelector.value = activeId;
  }

  function parseExtraBody() {
    try {
      return extraBody.value.trim() ? JSON.parse(extraBody.value) : {};
    } catch {
      throw new Error('额外请求参数不是有效 JSON');
    }
  }

  async function saveCurrentPreset(presetId = activePresetId) {
    if (!presetId) throw new Error('没有可保存的 API 预设');
    const preset = await api.updatePreset(presetId, {
      name: presetName.value.trim() || '未命名预设',
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value,
      modelsPath: modelsPath.value.trim() || '/v1/models',
      generationPath: generationPath.value.trim() || '/v1/images/generations',
      selectedModel: model.value,
      defaultSize: defaultSize.value,
      defaultQuality: defaultQuality.value,
      defaultCount: Number(defaultCount.value),
      timeoutMs: Number(timeout.value) * 1000,
      sendSize: sendSize.checked,
      sendQuality: sendQuality.checked,
      sendN: sendN.checked,
      extraBody: parseExtraBody(),
    });
    apiKey.value = '';
    apiKey.placeholder = preset.hasApiKey
      ? `当前预设已保存：${preset.apiKeyMask}`
      : '当前预设尚未保存密钥';
    const index = presets.findIndex(item => item.id === preset.id);
    if (index >= 0) presets[index] = preset;
    else presets.push(preset);
    updatePresetSelector(preset.id);
    return preset;
  }

  const fetchModels = action('拉取模型', async () => run(fetchModels, async () => {
    let preset = await saveCurrentPreset();
    const result = await api.listModels(activePresetId);
    updateModelList(result.models, preset.selectedModel);
    if (!model.value && result.models[0]?.id) model.value = result.models[0].id;
    preset = await api.updatePreset(activePresetId, { selectedModel: model.value });
    const index = presets.findIndex(item => item.id === preset.id);
    if (index >= 0) presets[index] = { ...preset, cachedModels: result.models };
    store.set({ preset });
    status.textContent = `已拉取 ${result.models.length} 个模型，请在左侧下拉框选择`;
  }));

  const modelRow = document.createElement('div');
  modelRow.className = 'stia-inline-control';
  modelRow.append(model, fetchModels);

  const createPreset = action('新建', async () => {
    const name = window.prompt('给这个 API 预设起个名字', '新预设');
    if (name == null) return;
    await run(createPreset, async () => {
      if (activePresetId) await saveCurrentPreset();
      const preset = await api.createPreset({ name: name.trim() || '新预设' });
      presets.push(preset);
      activePresetId = preset.id;
      updatePresetSelector(preset.id);
      loadPresetFields(preset);
      store.set({ preset });
      status.textContent = `已新建预设“${preset.name}”`;
    });
  });

  const deletePreset = action('删除', async () => {
    const current = presets.find(item => item.id === activePresetId);
    if (!current || !confirm(`确定删除 API 预设“${current.name}”吗？`)) return;
    await run(deletePreset, async () => {
      const result = await api.deletePreset(activePresetId);
      presets = presets.filter(item => item.id !== activePresetId);
      const preset = result.activePreset;
      activePresetId = preset.id;
      updatePresetSelector(preset.id);
      loadPresetFields(preset);
      store.set({ preset });
      status.textContent = '预设已删除';
    });
  });
  deletePreset.classList.add('stia-button--danger');

  const presetRow = document.createElement('div');
  presetRow.className = 'stia-inline-control';
  presetRow.append(presetSelector, createPreset, deletePreset);

  presetSelector.addEventListener('change', async () => {
    const nextId = presetSelector.value;
    const previousId = activePresetId;
    if (!nextId || nextId === previousId) return;
    await run(presetSelector, async () => {
      await saveCurrentPreset(previousId);
      const selected = await api.selectPreset(nextId);
      activePresetId = selected.id;
      const local = presets.find(item => item.id === selected.id);
      const preset = { ...local, ...selected };
      loadPresetFields(preset);
      store.set({ preset });
      status.textContent = `已切换到“${preset.name}”`;
    });
    if (activePresetId === previousId) presetSelector.value = previousId;
  });

  const createArtistPreset = action('新建', async () => {
    const name = window.prompt('给这套画师串起个名字', '新画师串');
    if (name == null) return;
    await run(createArtistPreset, async () => {
      if (activeArtistPresetId) await saveCurrentArtistPreset();
      const preset = await api.createArtistPreset({ name: name.trim() || '新画师串' });
      artistPresets.push(preset);
      activeArtistPresetId = preset.id;
      updateArtistSelector(preset.id);
      loadArtistFields(preset);
      store.set({ artistPreset: preset });
      status.textContent = `已新建画师串“${preset.name}”`;
    });
  });

  const deleteArtistPreset = action('删除', async () => {
    const current = artistPresets.find(item => item.id === activeArtistPresetId);
    if (!current || !confirm(`确定删除画师串预设“${current.name}”吗？`)) return;
    await run(deleteArtistPreset, async () => {
      const result = await api.deleteArtistPreset(activeArtistPresetId);
      artistPresets = artistPresets.filter(item => item.id !== activeArtistPresetId);
      const preset = result.activeArtistPreset;
      activeArtistPresetId = preset.id;
      updateArtistSelector(preset.id);
      loadArtistFields(preset);
      store.set({ artistPreset: preset });
      status.textContent = '画师串预设已删除';
    });
  });
  deleteArtistPreset.classList.add('stia-button--danger');

  const artistPresetRow = document.createElement('div');
  artistPresetRow.className = 'stia-inline-control';
  artistPresetRow.append(artistSelector, createArtistPreset, deleteArtistPreset);

  artistSelector.addEventListener('change', async () => {
    const nextId = artistSelector.value;
    const previousId = activeArtistPresetId;
    if (!nextId || nextId === previousId) return;
    await run(artistSelector, async () => {
      await saveCurrentArtistPreset(previousId);
      const preset = await api.selectArtistPreset(nextId);
      activeArtistPresetId = preset.id;
      loadArtistFields(preset);
      store.set({ artistPreset: preset });
      status.textContent = `已切换到画师串“${preset.name}”`;
    });
    if (activeArtistPresetId === previousId) artistSelector.value = previousId;
  });

  const clearNovelAiKey = action('清除', async () => {
    if (!confirm('确定清除已保存的 NAI 中转站 Key / Token 吗？')) return;
    await run(clearNovelAiKey, async () => {
      await api.clearNovelAiSecret();
      if (novelAiConfig) Object.assign(novelAiConfig, { hasApiKey: false, apiKeyMask: '' });
      novelAiKey.value = '';
      novelAiKey.placeholder = '当前尚未保存中转站 Key / NAI Token';
      status.textContent = 'NAI 中转站 Key / Token 已清除';
    });
  });
  clearNovelAiKey.classList.add('stia-button--danger-soft', 'stia-button--compact');

  const save = action('保存预设', saveSettings, true);
  const test = action('测试模型接口', async () => run(test, async () => {
    const preset = await saveCurrentPreset();
    const result = await api.testPreset(preset.id);
    store.set({ preset });
    status.textContent = `模型接口连接成功，共发现 ${result.modelCount} 个模型；生图接口会在实际生成时单独验证`;
  }));
  const clearKey = action('清除当前预设密钥', async () => {
    if (!confirm('确定清除当前 API 预设保存的密钥吗？')) return;
    await run(clearKey, async () => {
      await api.clearSecret(activePresetId);
      const current = presets.find(item => item.id === activePresetId);
      if (current) Object.assign(current, { hasApiKey: false, apiKeyMask: '' });
      apiKey.value = '';
      apiKey.placeholder = '当前预设尚未保存密钥';
      status.textContent = '当前预设的密钥已清除';
    });
  });
  clearKey.textContent = '清除';
  clearKey.setAttribute('aria-label', '清除当前预设密钥');
  clearKey.classList.add('stia-button--danger-soft', 'stia-button--compact');

  const pageHeading = document.createElement('div');
  pageHeading.className = 'stia-page-heading';
  const pageTitle = document.createElement('div');
  pageTitle.className = 'stia-page-title';
  pageTitle.innerHTML = '<span aria-hidden="true">⚙</span><strong>设置</strong>';
  const enabledField = field('扩展已启用', enabled);
  enabledField.classList.add('stia-switch-field');
  pageHeading.append(pageTitle, enabledField);

  const engineSwitch = document.createElement('div');
  engineSwitch.className = 'stia-engine-switch';
  const openAiEngine = action('GPT / OpenAI', async () => run(openAiEngine, () => changeProvider('openai')));
  const novelAiEngine = action('NovelAI', async () => run(novelAiEngine, () => changeProvider('novelai')));
  engineSwitch.append(openAiEngine, novelAiEngine);

  const apiSection = document.createElement('section');
  apiSection.className = 'stia-section';
  const apiTitle = document.createElement('h3');
  apiTitle.innerHTML = '<span aria-hidden="true">▤</span> API 配置';
  const apiGrid = document.createElement('div');
  apiGrid.className = 'stia-form-stack';
  const presetField = field('API 预设', presetRow);
  const keyRow = document.createElement('div');
  keyRow.className = 'stia-inline-control';
  keyRow.append(apiKey, clearKey);
  const urlField = field('Base URL', baseUrl);
  urlField.append(urlPreview);
  apiGrid.append(
    presetField,
    field('预设名称', presetName),
    urlField,
    field('API Key', keyRow),
    field('模型', modelRow),
  );
  const apiActions = document.createElement('div');
  apiActions.className = 'stia-actions stia-actions--fill';
  save.textContent = '✓  保存预设';
  test.textContent = '⌁  测试模型接口';
  apiActions.append(save, test);
  apiSection.append(apiTitle, apiGrid, apiActions);

  const generationSection = document.createElement('section');
  generationSection.className = 'stia-section';
  const generationTitle = document.createElement('h3');
  generationTitle.innerHTML = '<span aria-hidden="true">▧</span> 生图参数';
  const generationGrid = document.createElement('div');
  generationGrid.className = 'stia-form-grid stia-form-grid--compact';
  const defaultSizeField = field('默认尺寸', defaultSize);
  const sizeDescription = document.createElement('small');
  sizeDescription.className = 'stia-muted';
  sizeDescription.textContent = '不同模型支持的尺寸可能不同；若上游拒绝，请换用该模型支持的尺寸或 auto。';
  defaultSizeField.append(sizeDescription);
  generationGrid.append(
    defaultSizeField,
    field('默认质量', defaultQuality),
    field('默认数量', defaultCount),
  );
  const autoField = field('自动生图', autoGenerate);
  autoField.classList.add('stia-switch-field', 'stia-switch-field--row');
  const autoDescription = document.createElement('small');
  autoDescription.textContent = '新消息完成后自动生成图片';
  autoField.querySelector('span')?.append(autoDescription);
  generationSection.append(generationTitle, generationGrid);

  const novelAiSection = document.createElement('section');
  novelAiSection.className = 'stia-section stia-section--novelai';
  novelAiSection.hidden = true;
  const novelAiTitle = document.createElement('h3');
  novelAiTitle.innerHTML = '<span aria-hidden="true">✦</span> NovelAI 配置';
  const novelAiGrid = document.createElement('div');
  novelAiGrid.className = 'stia-form-stack';
  const novelAiKeyRow = document.createElement('div');
  novelAiKeyRow.className = 'stia-inline-control';
  novelAiKeyRow.append(novelAiKey, clearNovelAiKey);
  const novelAiUrlField = field('NAI 中转站 / 兼容站 URL', novelAiBaseUrl);
  novelAiUrlField.append(novelAiUrlPreview);
  novelAiGrid.append(
    novelAiUrlField,
    field('中转站 Key / NAI Token', novelAiKeyRow),
    field('模型', novelAiModel),
  );

  const artistHeading = document.createElement('h4');
  artistHeading.className = 'stia-subheading';
  artistHeading.textContent = '画师串预设';
  const artistGrid = document.createElement('div');
  artistGrid.className = 'stia-form-stack stia-artist-preset';
  artistGrid.append(
    field('选择预设', artistPresetRow),
    field('预设名称', artistName),
    field('画师串 / 风格串', artistPrompt),
  );
  const artistHint = document.createElement('small');
  artistHint.className = 'stia-muted';
  artistHint.textContent = '生成时按“画师串 → 正文提示词 → 质量标签”的顺序自动组合；不会改写聊天正文。';
  artistGrid.append(artistHint);

  const novelAiParametersHeading = document.createElement('h4');
  novelAiParametersHeading.className = 'stia-subheading';
  novelAiParametersHeading.textContent = '生图参数';
  const novelAiParameters = document.createElement('div');
  novelAiParameters.className = 'stia-form-grid stia-form-grid--compact';
  novelAiParameters.append(
    field('默认尺寸', novelAiSize),
    field('默认数量', novelAiCount),
    field('采样器', novelAiSampler),
    field('噪声调度', novelAiSchedule),
    field('步数', novelAiSteps),
    field('Prompt Guidance', novelAiScale),
    field('种子（-1 随机）', novelAiSeed),
  );

  const novelAiAdvanced = document.createElement('details');
  novelAiAdvanced.className = 'stia-advanced';
  const novelAiAdvancedSummary = document.createElement('summary');
  novelAiAdvancedSummary.textContent = 'NovelAI 高级设置';
  const novelAiAdvancedGrid = document.createElement('div');
  novelAiAdvancedGrid.className = 'stia-form-grid';
  for (const [labelText, control] of [
    ['自动加入模型质量标签', novelAiQualityTags],
    ['SMEA', novelAiSmea],
    ['SMEA DYN', novelAiSmeaDyn],
    ['Variety', novelAiVariety],
  ]) {
    const item = field(labelText, control);
    item.classList.add('stia-field--check');
    novelAiAdvancedGrid.append(item);
  }
  novelAiAdvancedGrid.append(
    field('Guidance Rescale', novelAiCfgRescale),
    field('生图路径', novelAiGenerationPath),
    field('超时（秒）', novelAiTimeout),
    field('固定负面提示词', novelAiNegative),
  );
  novelAiAdvanced.append(novelAiAdvancedSummary, novelAiAdvancedGrid);

  const saveNovelAi = action('✓  保存 NovelAI 配置', saveSettings, true);
  const novelAiActions = document.createElement('div');
  novelAiActions.className = 'stia-actions stia-actions--fill';
  novelAiActions.append(saveNovelAi);
  const novelAiNotice = document.createElement('p');
  novelAiNotice.className = 'stia-warning';
  novelAiNotice.textContent = '优先支持 NAI 原生格式中转站：填写中转站 URL 与中转 Key，插件会以 Bearer 鉴权调用 /ai/generate-image。Aurora 可填写以 /api 或 /api/v1 结尾的地址，插件会自动请求 /api/ai/generate-image。也可直接填写完整生图端点；兼容 ZIP、JSON/Base64 图片返回。Key 只保存在当前酒馆账户中。';
  novelAiSection.append(
    novelAiTitle,
    novelAiGrid,
    artistHeading,
    artistGrid,
    novelAiParametersHeading,
    novelAiParameters,
    novelAiAdvanced,
    novelAiActions,
    novelAiNotice,
  );

  const automationSection = document.createElement('section');
  automationSection.className = 'stia-section stia-section--compact';
  automationSection.append(autoField);

  const warning = document.createElement('p');
  warning.className = 'stia-warning';
  warning.textContent = '直连模式下，每个预设的 Key 独立保存在当前酒馆账户中；中转站必须允许 CORS。HTTP 仅适合受信任的本地服务。';
  const advanced = document.createElement('details');
  advanced.className = 'stia-advanced';
  const advancedSummary = document.createElement('summary');
  advancedSummary.textContent = '高级设置';
  const advancedGrid = document.createElement('div');
  advancedGrid.className = 'stia-form-grid';
  for (const [labelText, control] of [
    ['允许 HTTP（不安全）', allowHttp],
    ['发送 size 参数', sendSize],
    ['发送 quality 参数', sendQuality],
    ['发送 n 参数', sendN],
  ]) {
    const item = field(labelText, control);
    item.classList.add('stia-field--check');
    advancedGrid.append(item);
  }
  advancedGrid.append(
    field('运行模式', executionMode),
    field('模型列表路径', modelsPath),
    field('生图路径', generationPath),
    field('超时（秒）', timeout),
    field('额外请求参数 JSON', extraBody),
    warning,
  );
  advanced.append(advancedSummary, advancedGrid);

  function setProvider(provider, announce = true) {
    const isNovelAi = provider === 'novelai';
    const wasNovelAi = generationProvider.value === 'novelai';
    if (isNovelAi && !wasNovelAi) openAiExecutionMode = executionMode.value || 'direct';
    if (!isNovelAi && wasNovelAi) executionMode.value = openAiExecutionMode;
    generationProvider.value = isNovelAi ? 'novelai' : 'openai';
    apiSection.hidden = isNovelAi;
    generationSection.hidden = isNovelAi;
    advanced.hidden = isNovelAi;
    novelAiSection.hidden = !isNovelAi;
    openAiEngine.classList.toggle('stia-button--primary', !isNovelAi);
    novelAiEngine.classList.toggle('stia-button--primary', isNovelAi);
    openAiEngine.setAttribute('aria-pressed', String(!isNovelAi));
    novelAiEngine.setAttribute('aria-pressed', String(isNovelAi));
    executionMode.disabled = isNovelAi;
    if (isNovelAi) executionMode.value = 'direct';
    createPreset.disabled = !isNovelAi && executionMode.value === 'server';
    deletePreset.disabled = !isNovelAi && executionMode.value === 'server';
    health.textContent = isNovelAi
      ? '● NovelAI 兼容接口已就绪'
      : api.mode() === 'server'
        ? '● Server Plugin 已连接'
        : '● 免服务端模式已就绪';
    store.set({
      settings: {
        ...store.state.settings,
        generationProvider: isNovelAi ? 'novelai' : 'openai',
        ...(isNovelAi ? { executionMode: 'direct' } : {}),
      },
    });
    if (announce) {
      status.className = 'stia-status';
      status.textContent = isNovelAi
        ? '已切换到 NovelAI；保存配置后，正文中的生图标签将使用 NAI'
        : '已切换到 GPT / OpenAI-compatible 生图';
    }
  }

  async function changeProvider(provider) {
    setProvider(provider, false);
    const isNovelAi = provider === 'novelai';
    const nextSettings = await api.updateSettings({
      generationProvider: isNovelAi ? 'novelai' : 'openai',
      executionMode: isNovelAi ? 'direct' : executionMode.value,
    });
    store.set({ settings: nextSettings });
    status.className = 'stia-status';
    status.textContent = isNovelAi
      ? '已切换到 NovelAI；正文中的生图标签将使用当前 NAI 配置'
      : '已切换到 GPT / OpenAI-compatible 生图';
  }

  novelAiSmea.addEventListener('change', () => {
    novelAiSmeaDyn.disabled = novelAiModel.value !== 'nai-diffusion-3' || !novelAiSmea.checked;
    if (!novelAiSmea.checked) novelAiSmeaDyn.checked = false;
  });
  novelAiModel.addEventListener('change', syncNovelAiModelControls);

  settingsPage.append(
    pageHeading,
    engineSwitch,
    apiSection,
    generationSection,
    novelAiSection,
    automationSection,
    advanced,
    status,
  );

  async function saveSettings() {
    const saveControl = generationProvider.value === 'novelai' ? saveNovelAi : save;
    await run(saveControl, async () => {
      const previousMode = api.mode();
      const provider = generationProvider.value === 'novelai' ? 'novelai' : 'openai';
      const requestedMode = provider === 'novelai' ? 'direct' : executionMode.value;
      let preset = store.state.preset;
      let savedNovelAi = store.state.novelAi;
      let savedArtist = store.state.artistPreset;
      if (provider === 'novelai') {
        savedNovelAi = await saveNovelAiConfig();
        savedArtist = await saveCurrentArtistPreset();
      } else {
        preset = await saveCurrentPreset();
      }
      const nextSettings = await api.updateSettings({
        enabled: enabled.checked,
        autoGenerate: autoGenerate.checked,
        generationProvider: provider,
        executionMode: requestedMode,
        allowHttp: allowHttp.checked,
      });
      if (provider === 'openai' && previousMode !== requestedMode) {
        const presetData = await api.getPresets();
        presets = presetData.items || [];
        preset = presets.find(item => item.id === presetData.activePresetId) || presets[0];
        if (!preset) throw new Error('切换运行模式后没有可用的 API 预设');
        activePresetId = preset.id;
        updatePresetSelector(preset.id);
        loadPresetFields(preset);
      }
      store.set({
        settings: nextSettings,
        preset,
        novelAi: savedNovelAi,
        artistPreset: savedArtist,
      });
      const healthData = await api.health();
      health.textContent = provider === 'novelai'
        ? '● NovelAI 兼容接口已就绪'
        : healthData.mode === 'direct'
          ? '● 免服务端模式已就绪'
          : '● Server Plugin 已连接';
      health.classList.add('is-ready');
      status.textContent = provider === 'novelai'
        ? `NovelAI 配置与画师串“${savedArtist.name}”已保存`
        : executionMode.value === 'direct'
          ? `API 预设“${preset.name}”已保存`
          : '设置已保存；当前为 Server Plugin 增强模式';
    });
  }

  async function load() {
    try {
      const [healthData, settings, presetData, novelAiData] = await Promise.all([
        api.health(), api.getSettings(), api.getPresets(), api.getNovelAi(),
      ]);
      presets = presetData.items || [];
      const preset = presets.find(item => item.id === presetData.activePresetId) || presets[0];
      if (!preset) throw new Error('没有可用的 API 预设');
      artistPresets = novelAiData.artistPresets || [];
      const artistPreset = artistPresets
        .find(item => item.id === novelAiData.activeArtistPresetId) || artistPresets[0];
      if (!artistPreset) throw new Error('没有可用的画师串预设');
      activePresetId = preset.id;
      activeArtistPresetId = artistPreset.id;
      updatePresetSelector(preset.id);
      updateArtistSelector(artistPreset.id);
      const provider = settings.generationProvider === 'novelai' ? 'novelai' : 'openai';
      health.textContent = provider === 'novelai'
        ? '● NovelAI 兼容接口已就绪'
        : healthData.mode === 'direct'
          ? '● 免服务端模式已就绪'
          : '● Server Plugin 已连接';
      health.classList.add('is-ready');
      enabled.checked = settings.enabled;
      autoGenerate.checked = settings.autoGenerate;
      executionMode.value = provider === 'novelai'
        ? 'direct'
        : settings.executionMode || healthData.mode || 'direct';
      openAiExecutionMode = settings.executionMode || healthData.mode || 'direct';
      allowHttp.checked = settings.allowHttp;
      createPreset.disabled = executionMode.value === 'server';
      deletePreset.disabled = executionMode.value === 'server';
      loadPresetFields(preset);
      loadNovelAiFields(novelAiData.config);
      loadArtistFields(artistPreset);
      syncNovelAiModelControls();
      store.set({
        health: healthData,
        settings,
        preset,
        novelAi: novelAiData.config,
        artistPreset,
        serviceError: null,
      });
      setProvider(provider, false);
    } catch (error) {
      health.textContent = api.mode() === 'server'
        ? '○ Server Plugin 未连接'
        : '○ 免服务端模式初始化失败';
      health.classList.remove('is-ready');
      status.className = 'stia-status stia-error';
      status.textContent = error.message;
      store.set({ serviceError: error });
    }
  }

  executionMode.addEventListener('change', () => {
    if (generationProvider.value === 'openai') openAiExecutionMode = executionMode.value;
    const serverMode = executionMode.value === 'server';
    createPreset.disabled = serverMode;
    deletePreset.disabled = serverMode;
  });

  function showTab(name) {
    const isSettings = name === 'settings';
    settingsPage.hidden = !isSettings;
    gallery.root.hidden = isSettings;
    settingsTab.classList.toggle('stia-button--primary', isSettings);
    galleryTab.classList.toggle('stia-button--primary', !isSettings);
    if (!isSettings) void gallery.load({ reset: true });
  }

  function show(tabName = 'settings') {
    overlay.hidden = false;
    document.body.classList.add('stia-modal-open');
    showTab(tabName);
    close.focus();
  }

  function hide() {
    overlay.hidden = true;
    document.body.classList.remove('stia-modal-open');
  }

  overlay.addEventListener('click', event => {
    if (event.target === overlay) hide();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !overlay.hidden) hide();
  });
  panel.append(header, tabs, settingsPage, gallery.root);
  overlay.append(panel);
  document.body.append(overlay);
  void load();
  return { show, hide, load };
}
