# Changelog

## 1.1.0 - 2026-07-31

- 默认改为免服务端直连模式，可从 SillyTavern 扩展窗口粘贴仓库链接安装。
- 使用酒馆内置 `/api/images/upload` 与 `/api/images/delete` 保存和删除图片。
- attempt、result 与删除抑制状态迁移到 `message.extra.stImageAtelier`。
- 画廊索引迁移到用户扩展设置，API Key 使用账户隔离的前端存储。
- 添加 CORS 专用错误诊断和直连模式自动化测试。
- Server Plugin 改为显式可选的增强模式，普通安装不再修改 `config.yaml`。

## 1.0.0 - 2026-07-31

- 完成 `<draw>` 多标签解析、稳定 Tag ID 与消息内卡片。
- 完成单 API 预设、模型拉取、连接测试和密钥隔离。
- 完成服务端幂等、URL/Base64 图片保存与重启中断恢复。
- 完成简化自动生图串行队列与每消息最多三个标签限制。
- 完成基础画廊、原图下载、删除墓碑和移动端主题适配。
- 添加安装、验证、卸载脚本和 mock 全链路测试。
