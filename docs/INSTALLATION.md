# 安装、升级与卸载

## 推荐：酒馆内一键安装

要求 SillyTavern 1.14.x–1.18.x。

1. 打开 SillyTavern 扩展管理。
2. 选择“安装扩展”。
3. 粘贴：

   ```text
   https://github.com/phyllis-0612/st-image-atelier
   ```

4. 安装后刷新页面或重启酒馆。
5. 打开「✦ Image Atelier」，确认状态为「免服务端模式已就绪」。

该方式只安装标准 UI Extension，不修改 `config.yaml`，也不要求 `enableServerPlugins`。

## 升级

在 SillyTavern 的已安装扩展列表中使用更新按钮，然后刷新页面。

从 1.0.0 升级到 1.1.0 后默认切换为免服务端模式。旧 Server Plugin 数据不会被删除；由于免服务端模式不会读取服务端 secrets，需要在设置中重新填写一次 API Key。

从 1.1.0 升级到 1.2.0 时，原来的单组 URL、Key、模型与缓存会自动迁移为第一个 API 预设，无需重新填写。之后每个新增预设会独立保存自己的 Key。

从 1.2.0 升级到 1.3.0 不需要重新配置。旧尺寸中若含乘号 `×`，保存或生图时会自动转换成 API 要求的英文小写 `x`。

升级到 1.5.0 时会自动补齐主题与画廊保留设置，默认跟随酒馆主题且自动清理保持关闭，不会在升级时删除现有图片。只有用户主动启用并确认规则后才开始清理。

## 免服务端模式说明

- 生成：浏览器直接调用 OpenAI Images 兼容端点。
- 存图：使用 SillyTavern 自带的 `/api/images/upload`。
- 删除：使用 SillyTavern 自带的 `/api/images/delete`。
- 卡片状态：保存在 `message.extra.stImageAtelier`。
- 画廊索引：保存在当前用户的扩展设置中。
- API Key：保存在当前 SillyTavern 账户的前端账户存储中。

中转站必须支持 CORS。Base URL 是 HTTPS 时无需额外设置；HTTP 默认禁止，只应在可信本地网络中手动开启。

## 可选：Server Plugin 增强模式

只有以下情况需要：

- 中转站不支持 CORS；
- 不允许 Key 进入浏览器运行时；
- 需要服务端进程锁、原子 JSON 元数据和更强的跨标签页幂等。

在 SillyTavern 主机上运行：

```bash
node scripts/install.mjs \
  --st /path/to/SillyTavern \
  --with-server-plugin \
  --enable-server-plugins
```

脚本会先备份 `config.yaml`，再安装 UI 与可选 Server Plugin。重启后在设置中把运行模式改为「Server Plugin 增强模式」。

验证增强模式：

```bash
node scripts/verify-install.mjs \
  --st /path/to/SillyTavern \
  --with-server-plugin
```

## 本地脚本的普通安装

如果不能使用酒馆安装界面，也可只安装普通扩展：

```bash
node scripts/install.mjs --st /path/to/SillyTavern
```

此命令不会安装 Server Plugin。

## 卸载

推荐直接在 SillyTavern 的扩展管理中删除扩展。图片位于当前用户图片目录的 `st-image-atelier` 子目录；扩展删除不会自动删除历史图片。

源码仓库也提供主机端卸载脚本：

```bash
node scripts/uninstall.mjs --st /path/to/SillyTavern
```

它会移除 UI 和可能存在的可选 Server Plugin，但默认保留用户图片与旧版服务端数据。
