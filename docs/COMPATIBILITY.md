# SillyTavern 兼容性

目标版本：1.14.x–1.18.x。实现采用特性检测，不比较运行时版本字符串。

## 版本矩阵

| 能力 | 1.14 | 1.15 | 1.16 | 1.17 | 1.18 | 实现 |
|---|---:|---:|---:|---:|---:|---|
| manifest UI Extension | ✓ | ✓ | ✓ | ✓ | ✓ | 标准 `manifest.json` |
| `getContext()` | ✓ | ✓ | ✓ | ✓ | ✓ | 依赖导入，保留全局回退 |
| `MESSAGE_RECEIVED` | ✓ | ✓ | ✓ | ✓ | ✓ | 只在该完成事件标记 live |
| `CHARACTER_MESSAGE_RENDERED` | ✓ | ✓ | ✓ | ✓ | ✓ | 仅渲染/恢复，不生成 |
| `CHAT_CHANGED` | ✓ | ✓ | ✓ | ✓ | ✓ | hydration，不生成 |
| 消息编辑事件 | `MESSAGE_EDITED` | `MESSAGE_EDITED` | 兼容检测 | `MESSAGE_UPDATED` + `MESSAGE_EDITED` | `MESSAGE_UPDATED` | 优先 UPDATED，回退 EDITED |
| `saveChatConditional()` | ✓ | ✓ | ✓ | ✓ | ✓ | 保存 `message.extra` |
| `getRequestHeaders()` CSRF | ✓ | ✓ | ✓ | ✓ | ✓ | 所有修改请求使用 |
| Server Plugins | ✓ | ✓ | ✓ | ✓ | ✓ | 需显式启用 |
| 多用户请求目录 | ✓ | ✓ | ✓ | ✓ | ✓ | 每请求解析用户 root |

## 兼容层边界

- UI 差异集中在 `src/ui/compat/st-api.js`。
- 服务端用户目录差异集中在 `server-plugin/src/compat/user-data.js`。
- 事件名以常量存在性检测，未使用 `if (version >= ...)`。
- hydration、聊天切换和重新渲染永远传 `live: false`。
- 首条角色问候的 `generationType === "first_message"` 不参与自动生图。

## 已知边界

没有本机 SillyTavern 实例，因此“实际加载”需安装后按 `TEST_PLAN.md` 执行。若某个定制分支没有向 Server Plugin 请求暴露用户目录，插件会返回中文 `SERVER_PLUGIN_UNAVAILABLE`，不会退化到共享目录，以免破坏多用户隔离。
