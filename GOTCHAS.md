# SecLog GOTCHAS — 踩坑记录

> 项目级 gotcha，避免重蹈覆辙。Agent 全局 gotcha 见 agent workspace 的 MEMORY.md。

---

## [GOTCHA-2026-07-16-001] CloudBase 文档库 stats 区间查询：不能链式 .where()

**现象**：`miaojiRecord` 云函数 stats 支持 `startDate/endDate` 区间，但实测只返回本月数据，
`month` 字段回显为 `this`，跨月范围过滤不生效。

**根因**：原代码先 `db.collection().where({createdAt: _.gte(start)})`，再
`q = q.where({createdAt: _.lt(end)})`。CloudBase 文档数据库（wx-server-sdk / tcb）的
**多次 `.where()` 是覆盖关系，不是 AND**——第二个 `where` 直接把第一个的 `_.gte(start)`
覆盖掉了，导致只剩 `_.lt(end)` 上限，下限丢失。

**修复**：在同一字段上用 command 的 `.and()` 合并：
```js
const createdAtCond = useLt ? _.gte(start).and(_.lt(end)) : _.gte(start)
const cond = { createdAt: createdAtCond }
if (owner) cond.openid = owner.openid
const q = db.collection(COLLECTION).where(cond)
```

**验证方法**（关键！）：
- 测区间 `2026-01-01 ~ 2026-06-30`（库里只有 7 月数据）→ 必须返回 `count:0`、`records:[]`。
  若返回全部 7 月数据，说明下限没生效（旧 bug 复现）。
- 测区间 `2026-01-01 ~ 2026-12-31` → 返回全部 18 条。

**关联**：MEMORY.md gotcha #9（改云函数必须重新上传才生效，用 CloudBase MCP `updateFunctionCode`）。

---

## [GOTCHA-2026-07-16-002] 秒记回复"两个头像 + 第一次空白" + "昨天"被当成"本月"

**现象**：
1. 问"今年/昨天花了多少"，回复出现**两个头像气泡**，第一次文字空白、第二次才有内容。
2. 问"昨天花了多少"，明细却是当月全天数据（如 7/14 一堆），明显算错区间。

**根因**：
- 头像重复：`agent-ui` 的 `sendMessage` 无条件 push 一条 `content:""` 的 assistant 占位记录（loading 态），
  而 `chatBot.onUserSend` 在判定为非 chat（query/record）后，又通过 `appendQueryMsg` 追加一条真实回复 → 两条气泡。
  `suppressModelOnce()` 只抑制了模型流式输出，没清掉那条空占位记录。
- "昨天"误判：`parseExpense` 只识别"今天"，不认识"昨天/前天"，落到兜底 `type:'month'`（本月）；
  且 `classifyIntent` 模型也可能把"昨天"判成 `day`（云函数 summary 的 day 只算今天），双重出错。

**修复**：
1. `components/agent-ui/index.js` `suppressModelOnce` 命中时，移除刚 push 的空 assistant 占位记录
   （`chatRecords.slice(0,-1)` 当末尾是 `role==='assistant' && !content`）。
2. `utils/parseExpense.js` `parseQuery` 加"昨天/前天/大前天"识别 → 转 `type:'range', range:{mode:'between',from,to}` 单日区间。
3. `pages/chatBot/chatBot.js`：
   - `case 'query'` 优先用正则 `queryHint`（当它是 range）覆盖模型的模糊判定；
   - between 分支 `label` 优先用 `q.rangeLabel`（"昨天"等友好文案）。

**验证**：
- 云函数单日区间 `2026-07-14 ~ 2026-07-14` 返回该 openid 下正确条数（openid 隔离是预期行为，两个测试账号数据不混）。
- "今年"→ range year 全年区间；"昨天"→ 单日 between。

**关联**：本文件 [GOTCHA-2026-07-16-001]（range 查询 _.and 合并）。

---

## [GOTCHA-2026-07-16-003] 前端拆「记账 / 查账」双 Tab + 周维度时间解析

**背景**：用户反馈"测试下来有问题"（非具体下拉组件，是整体体感：自然语言解析偶尔抽风、
双头像等）。决策：记账/查账入口分开，但**云函数不拆**（action 分发已够清晰，拆函数只增复杂度）。

**改动**：
1. `pages/chatBot/chatBot.wxml` 加顶部双 Tab：
   - 记账 Tab = 原 agent-ui（自然语言记账 + 拍照 FAB + OCR 弹窗）全保留，交互不变。
   - 查账 Tab = 预设按钮（今天/本周/上周/本月/今年）直调 `miaojiRecord` stats，**不经过模型**，
     返回明细列表。确定性路径，好测，绕开 LLM 解析不稳定。
2. `pages/chatBot/chatBot.js`：加 `activeTab` + `onSwitchTab` + `onQueryPreset`（直调云函数，
   日期格式化本地时区，金额取绝对值显示）。
3. `pages/chatBot/chatBot.wxss`：tab-bar + query-panel 样式。

**周维度修复**（`utils/parseExpense.js`）：加"本周/上周/这周/上礼拜"识别 →
自然周（周一起算）between 区间。此前"上周"被兜底成"本月"导致和"今年"返回相同（用户实测反馈）。

**验证**：扫码后切到「查账」Tab，点"上周"应返回 7/6~7/12 区间（非全月）；点"今天"返回 7/16。
自然语言"上周花了多少"在记账 Tab 聊天框里也应正确（正则优先覆盖模型）。

**注意**：查账 Tab 的 `onQueryPreset` 与记账 Tab 聊天框的 `tryQuery` 是两条独立路径，
改时间逻辑时要同步（或后续统一抽一个 `queryStats(payload)` 工具函数）。

---

## [GOTCHA-2026-07-16-004] 双 Tab 后记账页超长（agent-ui 100vh 撑爆）

**现象**：加 tab-bar 切换后，记账 Tab 的 agent-ui 内容区超出屏幕，整页可滚动、FAB 错位。

**根因**：`components/agent-ui/index.wxss` 根容器 `.agent-ui` 是 `height:100vh`，
包在 `<view wx:if>` 里时外层无高度约束，100vh 的 agent-ui + tab-bar 叠加 > 屏幕高度。

**修复**：
1. `.agent-ui` 根容器 `height:100vh` → `height:100%`（仅 chatBot 页用此组件，安全）。
2. `chatBot.wxml` 两个 tab 内容区包 `<view class="tab-content">`。
3. `chatBot.wxss`：`.page{height:100vh;display:flex;flex-direction:column;overflow:hidden}`、
   `.tab-content{flex:1;min-height:0;position:relative}`、`.tab-content .agent-ui{height:100%}`、
   `.query-panel{height:100%;overflow-y:auto}`。

**关键点**：flex 子项要能内部滚动，必须给父加 `min-height:0`（否则 flex 默认 `min-height:auto`
   不收缩，子项内容撑开父高度导致整页溢出）。

**注意**：agent-ui 内 `.set_panel_modal` / 侧边抽屉等浮层仍是 `height:100vh + fixed`（正确，勿改）。

---

## [GOTCHA-2026-07-16-005] 首页布局收敛（与对话页同构但不破坏下拉刷新）

**背景**：对话页修完超长后，首页也要同样收敛。但首页**不用 agent-ui**，是纯静态卡片，
且 `app.json` 开了 `enablePullDownRefresh`（首页 onPullDownRefresh 拉最新数据）。

**决策**：不与对话页一样整页 `height:100vh;overflow:hidden`（会禁掉页面级下拉刷新手势）。
采用折中：首页整页仍可滚动（兼容下拉刷新），但「最近记录」卡片限高 + 内部滚动。

**改动**（`pages/index/index.wxss`）：
- `.home` 保持 `min-height:100vh;display:flex;flex-direction:column`（不 overflow:hidden）。
- `.recent` 加 `flex:1; min-height:0; max-height:60vh; display:flex; flex-direction:column`。
- 记录列表容器加 class `.recent-list`（`flex:1; min-height:0; overflow-y:auto`），
  wxml 里 `<view wx:else class="recent-list">`。

**效果**：记录极多时只在「最近记录」卡片内滚动，不把整页拉爆；下拉刷新仍可用。

**区分**：对话页必须整页 overflow:hidden（agent-ui 内部自管滚动），首页不必——因无 100vh 子组件。

---

## [GOTCHA-2026-07-16-006] 查账面板：加「上月」+ 自定义日期选择器 + 按钮美化

**改动**（`pages/chatBot/chatBot.{wxml,wxss,js}`）：
1. `queryPresets` 加 `{key:'lastmonth', label:'上月'}`；`onQueryPreset` 加 lastmonth 分支，
   **跨年处理**（1月的上月=去年12月，算 lastDay 用 `new Date(ly, lm+1, 0)`）。
2. 按钮美化：`.preset-btn` 改白底卡片 + 阴影 + 圆角 16rpx，`:active` 渐变填充 + 微缩；
   `.preset-custom` 主色描边强调。
3. 自定义区间：加 `showRangePicker/rangeFrom/rangeTo` 状态 + `onOpenRangePicker/onCloseRangePicker/
   onRangeFromChange/onRangeToChange/onQueryRange` 方法。用**微信原生 `picker mode="date"`**
   （非自写日历，轻量可靠），起止各一个 date picker，带 start/end 互约束 + 顺序校验。

**为什么用原生 picker 而非自写日历**：
- 自写日历组件代码量大、易出边界 bug（闰年/跨月/时区）；原生 picker 由微信维护，体验一致。
- 记账场景选"某天到某天"用两个 date picker 足够，不需要可视化日历。

**验证**：查账 Tab 点「上月」→ 返回上月区间；点「自定义」→ 弹窗选起止日期 → 查询返回区间数据。
边界：rangeFrom>rangeTo 时 toast 提示；缺日期时提示。

**注意**：`onQueryRange` 与 `onQueryPreset` 的 result 格式化（日期本地化、金额绝对值）逻辑重复，
后续可抽 `formatStatsResult(r, label)` 工具函数统一（见 003 末尾备注）。

---

## [GOTCHA-2026-07-16-007] 查账按钮选中态残留（自定义点完还亮）

**现象**：选了「自定义」区间后，再点其他预设按钮，「自定义」仍显示高亮。

**根因**：`.preset-btn` 只有 `:active`（按下瞬间态），**没有持久选中态**。用户期望的是
"当前看的区间对应的按钮保持高亮"（和顶部 tab 一致的交互语言），但原实现点完自定义
视觉上停在那，切其他按钮也不清——因为没有"已选"标识，全靠 `:active` 残留观感误导。

**修复**：加 `activeQueryKey` 数据（预设=key，自定义='custom'）。
- `onQueryPreset` 设 `activeQueryKey:key`；`onQueryRange` 设 `activeQueryKey:'custom'`。
- 打开/关闭自定义弹窗**不改** activeQueryKey（只有真正查完才标记 custom），避免"打开又关掉"误标。
- wxml 预设/自定义按钮按 `activeQueryKey` 加 `.preset-selected`。
- wxss `.preset-selected` 用 `!important` 渐变填充持久高亮，区别于 `:active` 的瞬间缩放。

**关键点**：持久选中态必须用独立 class（`.preset-selected`），不能依赖 `:active`
（`:active` 在弹窗/长按场景可能视觉残留，且松手即失，不是"当前选中"语义）。
