# 架构

## 默认数据流

```text
MESSAGE_RECEIVED (live)
  -> 解析 <draw>
  -> message.extra.stImageAtelier 写入稳定 UUID
  -> saveChatConditional
  -> 手动点击或自动串行队列
  -> 按设置选择 GPT/OpenAI-compatible 或 NovelAI
  -> GPT：URL 下载 / Base64 解码
  -> NAI：组装画师串与 V4/V5 prompt 结构，解开 ZIP 图片包
  -> magic bytes + 30 MB 大小校验
  -> POST /api/images/upload
  -> 图片进入当前 ST 用户图片目录
  -> 卡片状态写回 message.extra
  -> 画廊索引写入 extension_settings
```

`CHAT_CHANGED`、启动 hydration、消息重渲染只解析和恢复，不产生上游请求。

## 默认存储

- `message.extra.stImageAtelier`
  - `messageUuid`
  - 稳定 `tagId`
  - attempt 状态
  - result 路径与元数据
  - 自动生成与删除抑制标记
- `extension_settings.stImageAtelier`
  - 当前生图引擎、普通设置和 GPT API 预设
  - NovelAI 非敏感参数与画师串预设
  - 画廊索引
  - 删除墓碑
- SillyTavern `accountStorage`
  - 彼此隔离的 GPT API Key 与 NovelAI Persistent API Token
- SillyTavern 用户图片目录
  - `st-image-atelier/<resultId>.<ext>`

图片 Base64 不写入聊天或扩展设置。

## 防重复

- 手动生成每次创建新 UUID。
- 自动生成固定使用 `auto:<tagId>`。
- 发起上游请求前，先把 attempt 写入聊天并等待 `saveChatConditional()` 完成。
- 当前页面用 `activeTags` 防止双击；已有 attemptId 会直接返回原记录。
- 刷新后遗留的活动状态改为 `interrupted`，不会自动重发。

免服务端模式无法提供跨浏览器标签页的服务端原子锁。极端情况下，两个页面同时操作同一聊天仍可能同时提交；需要该保证时使用增强模式。

## CORS 与 Key 边界

默认模式的上游请求发生在浏览器，因此要求 GPT 中转站或 NAI 兼容站允许 CORS。Key/Token 不进入聊天、画廊元数据或日志，但会存在于当前账户的前端存储和请求内存中。任何运行在同源页面上的前端代码都处于相同信任边界。

NovelAI 当前固定走直连模式；官方 `POST /ai/generate-image` 返回的 ZIP 在浏览器中解压，随后沿用与 GPT 相同的图片校验和 `/api/images/upload` 保存路径。第三方兼容站若直接返回 JSON/Base64 也会被识别。

## 可选 Server Plugin

切换到 `server` 模式后，原有 `/api/plugins/st-image-atelier/*` 路由继续提供：

- 服务端 secrets；
- attempt 进程锁与持久化幂等；
- URL 下载与文件校验；
- 原子 JSON metadata 与备份；
- 独立用户数据目录和服务端画廊。

该模式不是普通安装的前置条件。
