# Image Atelier

Image Atelier 是面向 SillyTavern 1.14.x–1.18.x 的 GPT / OpenAI-compatible 与 NovelAI 双引擎生图扩展。AI 回复完成后，它会识别 `<draw>...</draw>`，在消息原位置显示生图卡片，也可仅对本次会话中新完成的 AI 消息自动生图。

从 1.1.0 起，默认使用“免服务端直连”模式：只需在 SillyTavern 的扩展安装窗口粘贴仓库链接，不需要 Termux 命令，也不需要启用 Server Plugins。

## 一键安装

在 SillyTavern 的“安装扩展”中填写：

```text
https://github.com/phyllis-0612/st-image-atelier
```

安装完成后刷新页面或重启 SillyTavern。扩展菜单中会出现「✦ Image Atelier」，状态应显示「免服务端模式已就绪」。

也可以点击聊天输入框左下角的魔法棒按钮，在展开菜单中选择「Image Atelier」快速打开。

## 首次配置

设置页顶部可以随时切换「GPT / OpenAI」与「NovelAI」。切换后只会使用当前引擎的配置，两套密钥和预设互不覆盖。

### GPT / OpenAI-compatible

1. 保持运行模式为「免服务端直连（推荐，一键安装）」。
2. 在「API 预设」旁点击「新建」，自定义名称；填写 Base URL 和 API Key。
3. 在「模型」一栏点击旁边的「拉取模型」，然后从下拉框选择生图模型。
4. 点击「保存预设」。以后可直接用顶部预设下拉框快速切换整组 URL、Key 与模型。
5. 可点击「测试模型接口」确认模型列表接口；生图接口会在实际生成时单独验证。
6. 让 AI 回复：

```xml
<draw ratio="portrait" quality="high" count="1">
雨夜霓虹街道中的电影感人像
</draw>
```

默认手动点击生成；自动生图默认关闭。

### NovelAI

1. 切换到「NovelAI」。NAI 固定使用免服务端直连，不需要 Server Plugin。
2. 在「NAI 中转站 / 兼容站 URL」填写中转地址，在「中转站 Key / NAI Token」填写中转站分配的 Key。插件默认按 NAI 原生兼容格式，以 `Authorization: Bearer <Key>` 请求 `/ai/generate-image`；地址也可直接填写完整生图端点。Aurora 中转可填写以 `/api` 或 `/api/v1` 结尾的地址，插件会自动归一化到 `/api/ai/generate-image`，不要把 GPT 的 `/api/v1` 当成最终 NAI 生图端点。
3. 选择 NAI 模型、尺寸、采样器、步数、Prompt Guidance、种子与负面提示词。
4. 在「画师串预设」中新建并命名风格串。生成时会按「画师串 → 标签正文 → 模型质量标签」自动拼接，不会修改聊天原文。
5. 点击「保存 NovelAI 配置」。此后手动和自动生图都会使用当前 NAI 模型与画师串预设。

NAI 中转站 Key / NovelAI Token 与 GPT API Key 分开保存在当前酒馆账户存储中，不会写入扩展设置、聊天消息或图片元数据。中转站既可返回 NovelAI 原生 ZIP 图片包，也可返回常见 JSON/Base64 图片结构，插件会统一解析并逐张保存到酒馆图片目录。官方接口同样兼容：站点填写 `https://image.novelai.net` 即可。

NAI 中转站需要兼容 NovelAI 的原生生图请求体（`input`、`model`、`action`、`parameters`），并允许 SillyTavern 页面来源进行 CORS 跨域访问。若中转站只提供 OpenAI `/v1/images/generations` 格式，请改用「GPT / OpenAI」引擎；这种接口不是 NAI 原生协议，是否支持 NAI 专属采样参数取决于中转站。

## 主要能力

- 一条消息可含多个独立 `<draw>` 标签。
- 标签会在正文中的原位置直接替换成生图卡片；即使酒馆净化器移除了标签本身、只留下提示词，也会按提示词定位替换。正文完成后延迟追加的标签同样会实时识别。
- 同一标签可反复生成，历史结果全部保留。
- 自动生图使用固定 `auto:<tagId>`，刷新、切换聊天和重启不会重新提交；标签注入由 DOM 变化即时触发，低频扫描仅作兜底。
- URL 与 Base64 返回都会立即上传到当前 SillyTavern 用户的图片目录。
- 多 API 命名预设、独立密钥、模型下拉选择与快速切换。
- GPT / OpenAI-compatible 与 NovelAI 双引擎一键切换；NAI 支持独立站点、Token、模型和常用生成参数。
- 可命名、新建、删除和快速切换 NovelAI 画师串预设，并保留每张图实际使用的模型、画师预设与随机种子元数据。
- 生图失败会显示上游 HTTP 状态和经过脱敏的真实错误原因。
- 若上游内容审核拒绝提示词，会明确显示审核原因，不再混用参数不支持提示。
- 紧凑的五态消息卡片、分区设置页与双列响应式画廊。
- 内置方图、竖图和横图的常用尺寸（包括 `512x768`、`576x1024`、`1024x576` 等）；尺寸值会在请求前自动把 `×`、`X` 或 `*` 统一为接口要求的小写 `x`。
- 正文图片和画廊图片均可点击进入酒馆内的原图查看层；手机可直接长按保存，右上角固定关闭按钮、页面返回键和底部关闭按钮都能回到原聊天。
- 支持图片文件分享的系统会额外显示“分享 / 保存”按钮，不再把不稳定的自动文件下载作为移动端主流程。
- 时间倒序画廊、原图下载和墓碑删除。
- 深浅主题与移动端布局。
- 可选 Server Plugin 增强模式保留服务端密钥、进程锁和独立 JSON 元数据。

## 免服务端模式的网络要求

浏览器会直接请求中转站，因此中转站必须允许 SillyTavern 页面来源进行 CORS 跨域访问。若模型接口测试提示“浏览器无法连接”，请检查：

- Base URL 是否正确；
- 手机能否访问该地址；
- 中转站是否返回 `Access-Control-Allow-Origin`；
- HTTPS 页面是否请求了被浏览器拦截的 HTTP 地址。

API Key 保存在当前 SillyTavern 账户的前端账户存储中，不写入聊天消息、图片元数据、日志或 Git 仓库。由于请求发生在浏览器中，其他同源前端扩展理论上仍可访问请求数据；高安全需求请使用可选 Server Plugin 模式。

如果生成接口能连接，但返回的临时图片 URL 被 CORS 阻止，可在高级设置的额外参数中尝试填写 `{"response_format":"b64_json"}`，让兼容中转站直接返回 Base64。

## 可选增强模式

仓库仍包含 `server-plugin/`。它适用于不支持 CORS 的中转站，或必须把完整 Key 与生成幂等锁留在服务端的部署。安装方法见 [docs/INSTALLATION.md](docs/INSTALLATION.md)。普通用户无需安装。

## 测试

```bash
node --test
node scripts/verify-install.mjs --self
```

测试使用本地 mock upstream，不读取真实 API Key。

许可证：AGPL-3.0-or-later。
