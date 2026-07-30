import { createGalleryPage } from '../gallery/gallery.js';

function field(labelText, input) {
  const label = document.createElement('label');
  label.className = 'stia-field';
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(text, input);
  return label;
}

function input(type = 'text') {
  const element = document.createElement('input');
  element.type = type;
  return element;
}

function select(options) {
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
  const baseUrl = input('url');
  baseUrl.placeholder = 'https://api.example.com';
  const apiKey = input('password');
  apiKey.placeholder = '留空则保留现有密钥';
  apiKey.autocomplete = 'new-password';
  const model = input('text');
  model.setAttribute('list', 'stia-model-list');
  const modelList = document.createElement('datalist');
  modelList.id = 'stia-model-list';
  const defaultSize = input();
  const defaultQuality = input();
  const defaultCount = input('number');
  defaultCount.min = '1';
  defaultCount.max = '4';
  const timeout = input('number');
  timeout.min = '30';
  timeout.max = '600';
  const extraBody = document.createElement('textarea');
  extraBody.rows = 4;
  extraBody.placeholder = '{"background":"transparent"}';
  const sendSize = input('checkbox');
  const sendQuality = input('checkbox');
  const sendN = input('checkbox');
  const status = document.createElement('p');
  status.className = 'stia-status';
  status.setAttribute('role', 'status');
  const urlPreview = document.createElement('code');
  urlPreview.className = 'stia-url-preview';

  function normalizePreview() {
    try {
      const url = new URL(baseUrl.value);
      const baseParts = url.pathname.split('/').filter(Boolean);
      const route = ['v1', 'images', 'generations'];
      if (baseParts.at(-1)?.toLowerCase() === 'v1') route.shift();
      url.pathname = `/${[...baseParts, ...route].join('/')}`;
      urlPreview.textContent = url.toString();
    } catch {
      urlPreview.textContent = '填写 Base URL 后显示最终请求地址';
    }
  }
  baseUrl.addEventListener('input', normalizePreview);

  const basic = document.createElement('div');
  basic.className = 'stia-form-grid';
  const enabledField = field('启用扩展', enabled);
  enabledField.classList.add('stia-field--check');
  const autoField = field('自动生图（仅新完成消息）', autoGenerate);
  autoField.classList.add('stia-field--check');
  basic.append(
    enabledField,
    autoField,
    field('运行模式', executionMode),
    field('Base URL', baseUrl),
    field('API Key', apiKey),
    field('模型', model),
    field('默认尺寸', defaultSize),
    field('默认质量', defaultQuality),
    field('默认数量', defaultCount),
  );

  const warning = document.createElement('p');
  warning.className = 'stia-warning';
  warning.textContent = '免服务端模式会从浏览器直连 API，API Key 保存在当前酒馆账户的前端存储中；中转站必须允许 CORS。允许 HTTP 仅适合受信任的本地服务。';
  const advanced = document.createElement('details');
  const advancedSummary = document.createElement('summary');
  advancedSummary.textContent = '高级设置';
  const advancedGrid = document.createElement('div');
  advancedGrid.className = 'stia-form-grid';
  for (const [labelText, control] of [
    ['允许 HTTP', allowHttp],
    ['发送 size', sendSize],
    ['发送 quality', sendQuality],
    ['发送 n', sendN],
  ]) {
    const item = field(labelText, control);
    item.classList.add('stia-field--check');
    advancedGrid.append(item);
  }
  advancedGrid.append(field('超时（秒）', timeout), field('额外请求参数 JSON', extraBody), warning);
  advanced.append(advancedSummary, advancedGrid);

  const actions = document.createElement('div');
  actions.className = 'stia-actions';
  const save = action('保存设置', saveSettings, true);
  const fetchModels = action('拉取模型', async () => run(fetchModels, async () => {
    const result = await api.listModels();
    updateModelList(result.models);
    status.textContent = `已拉取 ${result.models.length} 个模型`;
  }));
  const test = action('测试连接', async () => run(test, async () => {
    const result = await api.testPreset();
    status.textContent = `连接成功，共发现 ${result.modelCount} 个模型`;
  }));
  const clearKey = action('清除密钥', async () => {
    if (!confirm('确定清除已保存的 API Key 吗？')) return;
    await run(clearKey, async () => {
      await api.clearSecret();
      apiKey.placeholder = '尚未保存密钥';
      status.textContent = '密钥已清除';
    });
  });
  actions.append(save, fetchModels, test, clearKey);
  settingsPage.append(basic, urlPreview, advanced, actions, status);

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

  function updateModelList(models) {
    modelList.replaceChildren();
    for (const item of models || []) {
      const option = document.createElement('option');
      option.value = item.id;
      modelList.append(option);
    }
  }

  async function saveSettings() {
    await run(save, async () => {
      let parsedExtra;
      try {
        parsedExtra = extraBody.value.trim() ? JSON.parse(extraBody.value) : {};
      } catch {
        throw new Error('额外请求参数不是有效 JSON');
      }
      const nextSettings = await api.updateSettings({
        enabled: enabled.checked,
        autoGenerate: autoGenerate.checked,
        executionMode: executionMode.value,
        allowHttp: allowHttp.checked,
      });
      const preset = await api.updatePreset({
        baseUrl: baseUrl.value,
        apiKey: apiKey.value,
        selectedModel: model.value,
        defaultSize: defaultSize.value,
        defaultQuality: defaultQuality.value,
        defaultCount: Number(defaultCount.value),
        timeoutMs: Number(timeout.value) * 1000,
        sendSize: sendSize.checked,
        sendQuality: sendQuality.checked,
        sendN: sendN.checked,
        extraBody: parsedExtra,
      });
      apiKey.value = '';
      apiKey.placeholder = preset.hasApiKey ? `已保存：${preset.apiKeyMask}` : '尚未保存密钥';
      store.set({ settings: nextSettings, preset });
      const healthData = await api.health();
      health.textContent = healthData.mode === 'direct'
        ? '● 免服务端模式已就绪'
        : '● Server Plugin 已连接';
      health.classList.add('is-ready');
      status.textContent = executionMode.value === 'direct'
        ? '设置已保存；当前为仓库链接直装模式'
        : '设置已保存；当前为 Server Plugin 增强模式';
    });
  }

  async function load() {
    try {
      const [healthData, settings, presets] = await Promise.all([
        api.health(), api.getSettings(), api.getPresets(),
      ]);
      const preset = presets.items[0];
      health.textContent = healthData.mode === 'direct'
        ? '● 免服务端模式已就绪'
        : '● Server Plugin 已连接';
      health.classList.add('is-ready');
      enabled.checked = settings.enabled;
      autoGenerate.checked = settings.autoGenerate;
      executionMode.value = settings.executionMode || healthData.mode || 'direct';
      allowHttp.checked = settings.allowHttp;
      baseUrl.value = preset.baseUrl;
      model.value = preset.selectedModel;
      defaultSize.value = preset.defaultSize;
      defaultQuality.value = preset.defaultQuality;
      defaultCount.value = String(preset.defaultCount);
      timeout.value = String(Math.round(preset.timeoutMs / 1000));
      extraBody.value = JSON.stringify(preset.extraBody || {}, null, 2);
      sendSize.checked = preset.sendSize;
      sendQuality.checked = preset.sendQuality;
      sendN.checked = preset.sendN;
      apiKey.placeholder = preset.hasApiKey ? `已保存：${preset.apiKeyMask}` : '尚未保存密钥';
      updateModelList(preset.cachedModels);
      normalizePreview();
      store.set({ health: healthData, settings, preset, serviceError: null });
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
  panel.append(header, tabs, settingsPage, gallery.root, modelList);
  overlay.append(panel);
  document.body.append(overlay);
  void load();
  return { show, hide, load };
}
