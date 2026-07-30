# 架构

## 数据流

```text
MESSAGE_RECEIVED (live)
  -> 解析 <draw>
  -> message.extra.stImageAtelier 写入稳定 UUID
  -> saveChatConditional
  -> POST /tags/resolve 恢复状态
  -> 手动点击或自动串行队列
  -> POST /generate (attemptId 幂等)
  -> OpenAI Images 兼容上游
  -> URL 下载 / Base64 解码
  -> magic bytes + 大小校验
  -> 原子落盘 + JSON metadata
  -> 消息卡片 / 画廊读取本地文件
```

`CHAT_CHANGED`、启动 hydration、消息重渲染只走“解析 → resolve → 渲染”，没有生成调用。

## 幂等

- 手动：每次点击创建 UUID attemptId。
- 自动：固定 `auto:<tagId>`。
- 服务端在写入 queued 之前使用 attempt 级进程锁。
- metadata 已存在时直接返回原 attempt。
- 重启时 queued/generating/downloading/saving 统一改为 interrupted，不重发。

## 存储

每个 ST 用户目录下：

```text
st-image-atelier/
├── config/settings.json
├── config/presets.json
├── secrets/default.json
├── metadata/index.json
├── metadata/index.backup.json
├── images/YYYY/MM/<resultId>.<ext>
└── tmp/
```

JSON 写入使用同目录临时文件、fsync、rename；写入前复制上一版为 backup。

## 二期预留

预设文件已是数组结构，记录保留 preset 快照、requestMode、schemaVersion。画廊分页使用 cursor。二期可在不迁移一期主键的前提下增加多预设、筛选、收藏、参考图和成本字段。
