# 环境勘察

勘察日期：2026-07-31

## 本机结果

- 当前施工工作区最初为空，不是 Git 仓库。
- 已在 `outputs/st-image-atelier` 初始化独立 Git 仓库和 `feat/st-image-atelier` 分支。
- 在常用目录（Documents、Desktop、Downloads、D 盘 data/Tools 等）没有发现 SillyTavern 安装。
- 系统 PATH 没有 Node；自动测试使用 Codex 工作区自带 Node.js 运行时完成。
- GitHub 公共仓库已创建为 `phyllis-0612/st-image-atelier`，初版由用户通过网页上传。

因此本轮无法做“当前安装实例”的加载测试。兼容勘察改用 SillyTavern 官方 1.14.0、1.15.0、1.16.0、1.17.0、1.18.0 tag 源码和官方文档；安装脚本接受实际 ST 路径后会再次验证版本和目录。

## 已核对接口

| 项目 | 勘察结论 |
|---|---|
| UI 入口 | `manifest.json` 的 `js` / `css` 字段，第三方目录位于 `public/scripts/extensions/third-party` |
| UI 上下文 | `getContext()`；1.14 起入口已暴露 `globalThis.SillyTavern.getContext` |
| 消息完成 | `eventSource` + `event_types.MESSAGE_RECEIVED`，流式处理在完成时发出 |
| 消息渲染 | `CHARACTER_MESSAGE_RENDERED` |
| 聊天切换 | `CHAT_CHANGED` |
| 消息编辑 | 兼容层优先 `MESSAGE_UPDATED`，回退 `MESSAGE_EDITED` |
| 持久化 | 修改 `chat[messageId].extra` 后调用 `saveChatConditional()`；兼容层保留 context 保存回退 |
| CSRF | `getRequestHeaders()` 统一带 `X-CSRF-Token` |
| 账户前端存储 | `accountStorage` 自 1.14 起可用，按当前 ST 账户隔离 |
| 内置图片保存 | `/api/images/upload` 接受 Base64 并保存到当前用户 `userImages` |
| 内置图片删除 | `/api/images/delete` 校验路径必须位于当前用户图片目录 |
| 服务端插件 | `plugins/<plugin>`，导出 `init(router)` 与 `info` |
| 服务端开关 | `config.yaml` 的 `enableServerPlugins`，默认关闭 |
| 用户隔离 | 优先使用请求会话的 `request.user.directories.root` |
| CSS | 使用 `--SmartTheme*` 变量，并为变量缺失设置安全 fallback |

## 1.1 架构复核

对比可仓库链接直装的 `st-chatu8` 后确认：普通 UI Extension 可以复用 SillyTavern 已有的图片保存、删除、设置和聊天元数据接口，因此 Image Atelier 默认模式不再需要自定义 Server Plugin。OpenAI Images 兼容中转站没有通用的酒馆内置代理，默认由浏览器直连并明确要求 CORS；原 Server Plugin 保留为无 CORS/高安全场景的可选模式。

## 官方来源

- SillyTavern tags：<https://github.com/SillyTavern/SillyTavern/tags>
- UI Extension 文档：<https://docs.sillytavern.app/for-contributors/writing-extensions/>
- Server Plugins 文档：<https://docs.sillytavern.app/for-contributors/server-plugins/>
- 官方扩展示例：<https://github.com/SillyTavern/Extension-GroupGreetings>
- 官方扩展示例：<https://github.com/SillyTavern/Extension-ImageMetadataViewer>
- 官方 Server Plugin 示例：<https://github.com/SillyTavern/SillyTavern-DiscordRichPresence-Server>
- 参考扩展：<https://github.com/damoshen123/st-chatu8>
