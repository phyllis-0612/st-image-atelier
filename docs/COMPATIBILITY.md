# SillyTavern 兼容性

目标版本：1.14.x–1.18.x。实现优先使用特性检测，不按运行时版本字符串分支。

## 版本矩阵

| 能力 | 1.14 | 1.15 | 1.16 | 1.17 | 1.18 | 实现 |
|---|---:|---:|---:|---:|---:|---|
| manifest UI Extension | ✓ | ✓ | ✓ | ✓ | ✓ | 标准 `manifest.json` |
| `getContext()` | ✓ | ✓ | ✓ | ✓ | ✓ | 导入并保留全局回退 |
| `MESSAGE_RECEIVED` | ✓ | ✓ | ✓ | ✓ | ✓ | 仅完成事件标记 live |
| `CHARACTER_MESSAGE_RENDERED` | ✓ | ✓ | ✓ | ✓ | ✓ | 仅渲染/恢复 |
| `CHAT_CHANGED` | ✓ | ✓ | ✓ | ✓ | ✓ | hydration，不生成 |
| `saveChatConditional()` | ✓ | ✓ | ✓ | ✓ | ✓ | 保存 `message.extra` |
| `getRequestHeaders()` | ✓ | ✓ | ✓ | ✓ | ✓ | 酒馆图片写操作携带 CSRF |
| `extension_settings` | ✓ | ✓ | ✓ | ✓ | ✓ | 预设与画廊索引 |
| `accountStorage` | ✓ | ✓ | ✓ | ✓ | ✓ | 账户隔离的前端 Key 存储 |
| NovelAI ZIP 解包 | ✓ | ✓ | ✓ | ✓ | ✓ | Store ZIP 直接读取，Deflate 使用浏览器 `DecompressionStream` |
| `/api/images/upload` | ✓ | ✓ | ✓ | ✓ | ✓ | Base64 图片落盘 |
| `/api/images/delete` | ✓ | ✓ | ✓ | ✓ | ✓ | 受用户目录边界保护的删除 |
| Server Plugins | 可选 | 可选 | 可选 | 可选 | 可选 | 仅增强模式需要 |

## 兼容层边界

- UI 差异集中在 `src/ui/compat/st-api.js`。
- 事件名以常量存在性检测，优先 `MESSAGE_UPDATED`，回退 `MESSAGE_EDITED`。
- hydration、聊天切换和重新渲染永远传 `live: false`。
- 首条角色问候的 `generationType === "first_message"` 不参与自动生图。
- 酒馆返回的相对图片路径统一转为根路径显示。

## 已知边界

- 免服务端模式依赖中转站 CORS；这不是 SillyTavern 版本问题。
- NovelAI 固定使用免服务端直连；官方站或第三方兼容站必须允许浏览器请求。
- 很旧、不支持 `DecompressionStream('deflate-raw')` 的浏览器无法解开压缩过的 NAI 图片包，会显示明确的升级提示。
- 浏览器不能读取 Server Plugin 的旧 secrets，切换模式后需重新填写 Key。
- 免服务端画廊索引随用户扩展设置保存；如果手工删除底层图片文件，索引可能显示失效条目。
- 已用 390px 浏览器视口完成双引擎设置页布局验收；真实 Token、CORS 与主题仍需安装后执行 `TEST_PLAN.md`。
