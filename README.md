# Image Atelier

Image Atelier 是面向 SillyTavern 1.14.x–1.18.x 的生图扩展。AI 回复完成后，它会识别 `<draw>...</draw>`，在消息内提供手动生成卡片，也可仅对本次会话中新完成的 AI 消息自动生图。

项目由两部分组成：

- UI Extension：标签解析、消息卡片、设置、自动队列与画廊。
- Server Plugin：密钥隔离、OpenAI Images 兼容请求、幂等、图片落盘和多用户隔离。

## 主要能力

- 一条消息可含多个独立 `<draw>` 标签。
- 同一标签可反复生成，历史结果全部保留。
- 服务端 `attemptId` 幂等，自动生图固定使用 `auto:<tagId>`。
- URL 与 Base64 图片都会立即保存到 ST 用户数据目录。
- 刷新、切换聊天和重启只恢复状态，绝不会触发生图。
- 单预设配置、模型拉取、连接测试、中文错误信息。
- 时间倒序画廊、原图下载和墓碑删除。
- 深浅主题与移动端布局。

## 安装

要求 Node.js 18+，并需要启用 SillyTavern Server Plugins。

```powershell
node scripts/install.mjs --st "D:\path\to\SillyTavern"
```

Linux / Termux：

```bash
node scripts/install.mjs --st /path/to/SillyTavern
```

脚本不会覆盖已有安装。确需升级时先备份，再传 `--force`。完整说明见 [docs/INSTALLATION.md](docs/INSTALLATION.md)。

## 使用

1. 重启 SillyTavern。
2. 打开扩展菜单中的「✦ Image Atelier」。
3. 填写 Base URL、API Key，拉取或手动填写模型。
4. 测试连接并保存。
5. 让 AI 回复：

```xml
<draw ratio="portrait" quality="high" count="1">
雨夜霓虹街道中的电影感人像
</draw>
```

默认手动点击生成；自动开关默认关闭。

## 测试

```bash
node --test
node scripts/verify-install.mjs --self
```

测试使用本地 mock upstream，不读取也不需要真实 API Key。

## 安全说明

- Key 仅保存在用户隔离的服务端 secrets 文件中。
- 默认仅允许 HTTPS；HTTP 必须在设置中明确开启。
- 图片限 30 MB，仅接受 PNG、JPEG、WebP。
- 文件路径经过目录边界检查。
- Server Plugins 具备服务端权限，请只从可信来源安装。

## 当前范围

这是第一期实现。多预设 UI、高级自动并发/重试、画廊高级筛选、参考图编辑、成本统计等只预留结构，不含实现。

许可证：AGPL-3.0-or-later。
