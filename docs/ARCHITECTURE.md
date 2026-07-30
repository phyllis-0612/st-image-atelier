# 架构

## 默认数据流

```text
MESSAGE_RECEIVED (live)
  -> 解析 <draw>
  -> message.extra.stImageAtelier 写入稳定 UUID
  -> saveChatConditional
  -> 手动点击或自动串行队列
  -> 浏览器直连 OpenAI Images 兼容端点
  -> URL 下载 / Base64 解码
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
  - 普通设置和预设
  - 画廊索引
  - 删除墓碑
- SillyTavern `accountStorage`
  - 免服务端模式的 API Key
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

默认模式的上游请求发生在浏览器，因此要求中转站允许 CORS。Key 不进入聊天、画廊元数据或日志，但会存在于当前账户的前端存储和请求内存中。任何运行在同源页面上的前端代码都处于相同信任边界。

## 可选 Server Plugin

切换到 `server` 模式后，原有 `/api/plugins/st-image-atelier/*` 路由继续提供：

- 服务端 secrets；
- attempt 进程锁与持久化幂等；
- URL 下载与文件校验；
- 原子 JSON metadata 与备份；
- 独立用户数据目录和服务端画廊。

该模式不是普通安装的前置条件。
