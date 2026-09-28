# 图片闪烁修复验证（1.6.5）

更新扩展后刷新 SillyTavern 页面，确认扩展版本为 1.6.5。

## 日常验证

1. 在同一聊天里放两张生图卡片，先生成第一张图片。
2. 开始生成第二张，观察第一张：第二张的生成、下载、保存和完成状态不应让第一张闪白或重新加载。增强模式下等待至少几个状态刷新周期。
3. 切换无关设置、收到新消息、识别新生图标签时，第一张同样保持显示。
4. 编辑第一张所在消息的正文，保留原 `<draw>` 提示词，保存编辑：原卡片和原图应回到对应位置，不出现重复提示词。对改写、保留相同标签的 swipe 或其他扩展重建楼层重复检查。
5. 点击第一张的「重新生成」：仍应显示正在重新生成和加载动画。取消后恢复旧图，成功后正常显示新图。
6. 画廊删除历史图片后，剩余卡片的历史数量更新；仍显示同一张图片时不应重新加载。点击图片和「调整后重绘」仍使用当前提示词。

## 精确检查节点是否复用

桌面浏览器打开开发者工具的控制台，在操作前保存第一张卡片和图片的引用：

```js
window.atelierCardBefore = document.querySelector('.mes_text .stia-card--succeeded');
window.atelierImageBefore = window.atelierCardBefore.querySelector('img');
window.atelierTagBefore = window.atelierCardBefore.dataset.tagId;
```

进行第二张生图、无关设置变化或第一张楼层重建后，再检查：

```js
const cardNow = [...document.querySelectorAll('.mes_text .stia-card')]
  .find(card => card.dataset.tagId === window.atelierTagBefore);
console.log({
  sameCard: cardNow === window.atelierCardBefore,
  sameImage: cardNow?.querySelector('img') === window.atelierImageBefore,
  connected: window.atelierImageBefore.isConnected,
});
```

保留相同生图标签和结果时，三项都应为 `true`。真正生成新结果或删除当前图片后，图片变化属于预期行为。修改生图提示词导致新标签 ID 时也会创建新卡片。

## 自动回归

```sh
node --test tests/unit/render-stability.test.js
npm test
npm run verify
```

专项测试直接检查 DOM 节点身份和 MutationObserver 记录，不以 HTML 内容相同代替节点复用。它覆盖重复轮询、无关卡片、同图历史变化、标签原文/转义/过滤/楼底四种重挂载、整个消息替换、离线期间状态变化、重新生成取消、最新事件快照及缓存清理。这些 DOM 测试不调用生图接口、不消耗 API 额度；实际手机浏览器的显示效果可按前述日常步骤确认。
