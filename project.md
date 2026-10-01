# project.md — 秒记账 (MiaoJi) 迭代手册

> **面向对象**：下一个接管本项目的 agent（或几个月后忘了细节的我自己）。
> **定位**：比 README 更细的工程手册——讲清每个文件干什么、代码为什么这么写、改动后怎么验证/部署。
> **配套文档**：`README.md`（产品/功能/启动）、`GOTCHAS.md`（踩坑流水账，按时间顺序）、本文件（结构化的工程约定）。三份互补，**改代码前先扫一遍这三份**。

---

## 0. 一句话背景

微信小程序「秒记账」= 微信原生小程序 + 腾讯云开发（CloudBase）+ 大模型。用户说自然语言 → 端侧正则抽线索 + 大模型判意图 → 云函数读写账本。模型**只做意图判断，不生成给用户看的文字**；所有回复都用真实数据拼模板，零幻觉。

- **CloudBase env**：`seclog-d1g8no5pc45e643aa`（ap-shanghai，个人版 `baas_personal`）
- **小程序 appid**（测试）：`WX_OWN_APPID_PLACEHOLDER`（在 `project.private.config.json`）
- **数据集合**：`miaoji_records`（账本）、`users`（用户档案）
- **基础库要求**：最低 `3.8.1`，本地推荐 `3.16.2`（`project.private.config.json`）

---

## 1. 目录结构与文件职责

```
SecLog/                              ← 微信开发者工具打开此目录（项目根）
├── miniprogram/                     ← ⭐ 小程序前端（已 git 跟踪）
│   ├── app.js                       ← 云 init + 静默登录（onLaunch 调 miaojiRecord.login）
│   ├── app.json                     ← 页面注册、tabBar、下拉刷新开关、插件声明（WechatSI 语音）
│   ├── app.wxss                     ← 全局样式
│   ├── pages/
│   │   ├── index/                   ← 首页：品牌 + 今日/本月汇总 + 最近5笔 + 入口（下拉刷新）
│   │   ├── chatBot/                 ← ⭐⭐ 核心：记账对话 + 拍照 OCR 弹窗 + 查账双 Tab
│   │   │   └── chatBot.js           ← 意图路由、多轮上下文、查询模板、OCR 确认流（最复杂的文件）
│   │   ├── guide/                   ← 使用引导页（独立入口，纯静态）
│   │   ├── profile/                 ← 个人中心：头像/昵称编辑、本月汇总、退出登录
│   │   └── records/                 ← ⭐ 记账明细：本月列表 + 编辑 + 删除（openid 隔离）
│   ├── components/
│   │   ├── agent-ui/                ← 对话主组件（腾讯官方组件库，勿大改；suppressModelOnce 在 index.js）
│   │   └── toolCard/                ← 地图/天气/商家卡（agent-ui 依赖，勿删）
│   ├── utils/
│   │   ├── extractByModel.js        ← ⭐ classifyIntent：大模型意图判断（含 prompt 构造 + 校验）
│   │   ├── parseExpense.js          ← ⭐ 正则抽 金额/分类/查询/撤回/日期（纯函数，分层线索）
│   │   ├── fallbackHint.js          ← 模型失败时的反问/万能提示
│   │   ├── collectStreamText.js     ← 流式响应文本收集（调 CloudBase AI streamText 用）
│   │   ├── cloudInstance.js         ← 取云开发实例（前端调 AI 用 cloudInstance.extend.AI）
│   │   ├── dateRange.js             ← computeCurrentMonthDays() 等日期工具（records 页用）
│   │   ├── deleteResult.js          ← checkDeleteResult() 三态判定（ok/not-found/fail）
│   │   └── __tests__/               ← node:test 纯函数单测（fallbackHint/dateRange/deleteResult/parseExpense）
│   └── package.json / sitemap.json
├── cloudfunctions/
│   ├── miaojiRecord/                ← ⭐⭐ 记账云函数（add/list/delete/update/summary/stats/ocr/login/updateProfile）
│   │   ├── index.js                 ← 主入口（exports.main 分发 action）
│   │   ├── parseOcr.js              ← OCR 返回的 JSON 容错解析 + 字段归一化（纯函数，云函数+测试共用）
│   │   ├── config.json / package.json
│   ├── ocrProbe/ / visionProbe/     ← 早期 OCR 探针（visionProbe 支持 --prompt 真 OCR 回归测试用）
│   └── quickstartFunctions/         ← 早期压测 demo，与产品无关，可删
├── ci-tools/                       ← ⭐⭐ 本地测试 + 编译（Jest + miniprogram-ci）
│   ├── compile.js                   ← 微信 CLI 编译，出真机预览/上传二维码（方案 A2：babel 转译后上传 .build 副本）
│   ├── jest.config.js
│   ├── package.json
│   ├── .env / .env.example          ← APPID / PRIVATE_KEY_PATH 等（.env 不提交）
│   ├── tests/                       ← Jest 用例（见 §5）
│   ├── __mocks__/                   ← wx-server-sdk / agent-ui / cloudbase-node-sdk 的 mock
│   ├── scripts/realOcrTest.js       ← 真 OCR 集成测试（不进 jest 默认套件，手动/CI 门控跑）
│   └── fixtures/alipay_bill_detail.jpg ← 永久 OCR 回归基线图
├── avatars/                         ← 用户头像云存储落地目录镜像（chooseAvatar 上传）
├── images/                          ← 小程序静态图（app-logo / default-avatar）
├── project.config.json              ← 微信开发者工具项目配置
├── project.private.config.json      ← 本地私有（appid 等，不提交）
├── uploadCloudFunction.sh           ← ⚠️ 只部署 quickstartFunctions（demo），不部署 miaojiRecord！
├── GOTCHAS.md / README.md / project.md
└── *.TODO.md / *.log / b64_oneline.txt / test_img_b64.txt  ← 过程产物，大部分可删（见 §7）
```

> **重要**：`uploadCloudFunction.sh` 是早期脚本，**只部署 `quickstartFunctions`**（demo 函数）。真正的业务函数 `miaojiRecord` **通过 CloudBase MCP（`manageFunctions` → `updateFunctionCode`，functionRootPath=项目根目录 `cloudfunctions`）部署**。不要把部署脚本当成部署 `miaojiRecord` 的途径。

---

## 2. 架构与数据流

### 2.1 核心原则

> **模型先做意图判断，代码按 action 选分支执行。** 模型在一轮里只输出意图 JSON，**绝不输出给用户看的散文**；查到的数据由代码拼模板，零幻觉。

### 2.2 对话记账数据流（chatBot 页）

```
用户输入（agent-ui 抛出 onUserSend）
  ↓ 正则同步段（parseExpense/parseQuery/parseUndo 抽线索）
  ↓   若命中非 chat 线索 → suppressModelOnce()（先让 agent-ui 闭嘴）
  ↓ classifyIntent（大模型判意图，结合 _history 滑动窗口 + _ctx 上一轮 + 正则多笔线索）
  ↓ switch(decision.action):
      record       → miaojiRecord(add) + ✅ 卡片
      multi_record → miaojiRecord(add) × N + ✅ 多笔汇总卡片（模型逐条校验+归一）
      correct      → miaojiRecord(update 最近一笔) + ✅ 卡片
      query        → miaojiRecord(stats/summary/list) + 📊 模板（真实数据，代码生成）
      undo         → miaojiRecord(list+delete) + 🗑️ 卡片
      chat         → 放行 agent-ui 模型自由对话（唯一模型发声的分支）
```

**三层防御（关键编码习惯）**：正则抽线索 → 模型兜底判意图 → **硬规则强制执行**。
- 正则命中 `regexExpense` / `queryHint` / `undoHint` 时，**无论模型说什么/是否失败，都强制执行**对应操作（doAdd / tryQuery / tryUndo）。
- 目的：杜绝"模型幻觉已记账但代码没写库"。模型角色从唯一决策者变为"正则未覆盖场景的兜底"。

### 2.3 拍照记账数据流（chatBot 页 FAB）

```
选图(wx.chooseMedia, sizeType:['original'])
  → wx.compressImage(最长边480, quality 50)   ← 大图 OCR 易超时，先压缩；sizeType:['original'] 让系统不压缩，二次压缩一手包办，避免两次有损叠加
  → wx.cloud.uploadFile(ocr_tmp/<时间戳>.ext)
  → miaojiRecord(ocr, {imageUrl: fileID})
      云函数内 fetchAsBase64DataUrl(fileID)
        → cloud:// → getTempFileURL → fetch → base64（不走调用链路，避免 401KB 原图 base64 塞 params）
        → 调 DeepSeek OpenAI 兼容 API（https://api.deepseek.com/chat/completions）
          · API Key 从环境变量 DEEPSEEK_API_KEY 读取（云函数环境变量注入，绝不硬编码进代码）
          · 模型名默认 deepseek-chat（多模态视觉版），可用环境变量 DEEPSEEK_MODEL 覆盖（如线上设 deepseek-flash）
          · content 顺序：image 在前、text 在后（避免模型把 text 当主任务、图当附件忽略）
        → parseOcrResponse() 容错解析 + 字段归一化
  → 前端确认弹窗（金额可改、**默认支出**、可一键切收入/支出）  ← 防错账：误识别不静默入库
  → miaojiRecord(add)
```

### 2.4 查询数据流（查账 Tab 或自然语言 query）

- **查账 Tab（确定性路径，不经过模型）**：点预设按钮（今天/本周/上月/本月/今年/去年）→ `onQueryPreset` 直调 `miaojiRecord(stats)` → 格式化后展示。好测、稳。
- **自然语言 query（记账 Tab 聊天框）**：`tryQuery(q)` 根据 `q.type` 选 action（stats/summary/list + payload）→ `buildQueryReply` 拼模板。

### 2.5 登录数据流

```
app.js onLaunch → silentLogin() → wx.login → miaojiRecord(login)
  → 取 openid/unionid，upsert users 集合 → 写 wx.storage('userInfo')
前端全局 globalData.userInfo 缓存；profile 页改头像/昵称 → updateProfile 回写
```

---

## 3. 核心文件详解（给迭代者的速查）

### 3.1 `miniprogram/utils/parseExpense.js`（端侧正则层）

**纯函数，无 wx / this 依赖，便于单测。** 导出：`parseExpense` / `parseExpenses` / `parseUndo` / `parseQuery` / `parseDateHint` / `parseChineseAmount`。

设计要点：
- **分类单一数据源**：`CATEGORY_KEYWORDS` 是唯一词库。改分类关键词只改这一处，`AMOUNT_PATTERNS` / `CATEGORY_MAP` / `INTENT_KEYS` **全部自动派生**（禁止手动维护派生结构）。
- **金额提取 6 模式**（`extractAmount`）：餐饮词+数字 / 收入词+数字 / 动作词+数字+单位 / 交通购物等类别词+数字+单位 / 中文数字+单位（`parseChineseAmount` 兜底）/ 纯数字+单位。
- **裸数字防护**：`matchesExpenseFallback` 覆盖白名单外新品类（`谷子20`/`手办15`），但排除量词组合（`岁|号|年|月|日|楼|kg|ml|个|张` 等）→ 不误记"身高180""第3名"。**v1.2.6 升级**：`matchesExpenseFallback` 不再死填 `category:'其他'`，改为返回 `category: null`，交给大模型 prompt 5.5 节用常识判断——冰淇淋→餐饮、打车→交通等，不再一股脑归"其他"。
- **收入判定**：`INCOME_RE` 命中 → 金额取正、分类落"收入"。
- **日期识别**（`_date` 字段）：`parseDateHint` 抽相对日期写 `YYYY-MM-DD`，交云函数 `add` 的 `date` 落库；无日期词 → `null`（存当天）。
- **撤回识别**（`parseUndo`）：确定性正则 `UNDO_RE`，不调模型。

> ⚠️ 改这文件后**必跑** `tests/extractByModel.test.js` + `utils/__tests__/parseExpense.test.js`（见 §5）。

### 3.2 `miniprogram/utils/extractByModel.js`（模型意图层）

**`classifyIntent(text, callModel, opts)`** 是统一意图路由器。导出：`classifyIntent` / `buildPrompt` / `extractJson` / `validateRecord` / `normalizeAmount` / `VALID_CATEGORIES`。

设计要点：
- `buildPrompt` 把正则线索（`regexExpense` / `queryHint` / `undoHint` / `history` / `ctx`）喂给模型，但**最终 decision 权在模型**。
- **prompt 5.5 节（v1.2.6 新增）**：当正则层抽到金额（`regexExpense` 非空）但 `category` 为 `null` 时，强制要求 LLM 用常识判断分类，不再死填"其他"。同时在 `parseExpense.js` 的 `CATEGORY_KEYWORDS.餐饮` 补充了 `冰淇淋/雪糕/冰棍/冰品/哈根达斯/冰激凌`，确保这些词正则层先命中餐饮→不走 5.5，但其他陌生品类词（如"手办"）仍由 LLM 5.5 节兜底。
- `validateRecord` 校验模型输出：金额超 `MAX_ABS_AMOUNT=1e7`、零、NaN → 退化 chat；`amount:null` → 被动填槽（上层追问）。
- `VALID_CATEGORIES` / `VALID_QUERY_TYPES` 白名单校验，模型输出非法值回退"其他"/month。

### 3.3 `cloudfunctions/miaoojiRecord/index.js`（后端）

`exports.main(event, context)` 按 `event.action` 分发。**所有筛选条件必须合并进单个 `where({...})`**（见 gotcha #1）。

- `add`：金额 `round2`；正数→income，负数→expense（或显式 `type`）。
- `list`：支持 `days` / `month:'this'` / `month:'YYYY-MM'` / `startDate+endDate` 四种过滤；**北京时间月边界**（`toUtcMidnight` 把入参当北京时间解释再换算 UTC）。
- `delete` / `update`：`where({_id, ...owner})` 严格按 owner 隔离。
- `summary`：今日/本月 income+expense（带符号：expense 负、income 正）。
- `stats`：按分类聚合（只算 expense），支持 month/range/category；返回 `records` 真实逐笔（前端拼明细用，**绝不编造**）。
- `ocr`：拍照记账入口，调 `extractFromImage` → **DeepSeek 视觉模型**（`https://api.deepseek.com/chat/completions`，OpenAI 兼容；API Key 走环境变量 `DEEPSEEK_API_KEY`，默认模型 `deepseek-chat`，可用 `DEEPSEEK_MODEL` 覆盖）。详见 §2.3。
- `login` / `updateProfile`：用户档案。

**全局约定（改云函数务必遵守）**：
- `round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100` —— 所有金额累加/出入点都过 round2，消除 `76.8 + 74.47 = 151.26999999999998` 长尾（**前端 wxml 不能调 `.toFixed()`**，见 gotcha #16：金额格式化必须在 JS 层做字符串字段 `xxxText`）。
- **北京时间偏移** `TZ_OFFSET = 8*60*60*1000`：所有"月/日"边界按北京时间视角构造，否则月底/月初统计全 0（gotcha #14）。

### 3.4 `miniprogram/pages/chatBot/chatBot.js`（前端最复杂文件）

职责：意图路由 + 多轮上下文（`_history` 滑窗 10 轮 + `_ctx` 远处摘要）+ 查询模板（`buildQueryReply`）+ 拍照 OCR 确认流（`onPhotoAccount` / `onOcrConfirm`）。

关键方法：
- `onUserSend`：同步段先 `suppressModelOnce`（若正则预判非 chat），再 `await classifyIntent`，最后按 action 分发。
- `onQueryPreset` / `onQueryRange`：查账 Tab 直调（确定性）。
- `doAdd` / `doAddMulti` / `tryCorrect` / `tryUndo` / `tryQuery`：各 action 执行。
- `buildQueryReply`：模板拼装（markdown，真实数据）。
- `onPhotoAccount` → `onOcrConfirm`：拍照 OCR 全链路。

### 3.5 `miniprogram/pages/records/records.js`（明细页）

- 默认 `month:'this'`（与查账面板口径一致）；从查账面板跳来（`targetId`+`mode`）→ 放大时间窗（days:3650）定位目标记录并自动打开编辑/删除。
- 编辑：`update`；删除：`delete` + `checkDeleteResult` 三态判定。
- 改/删后 `backToQueryAndRefresh` 刷新 chatBot 查账结果。

---

## 4. 编码习惯（给迭代者的硬规则）

1. **金额必 `round2`**：后端所有累加/前端显示前都过 round2；wxml 用预格式化的 `xxxText` 字符串，不调 `.toFixed()` / `?.`（gotcha #15/#16）。
2. **时区按北京时间**：所有月/日边界用 `TZ_OFFSET` 构造，数据库 `createdAt` 是 UTC。
3. **where 条件合并**：CloudBase 文档库多次 `.where()` 是**覆盖**不是 AND，多字段合并单对象，范围条件用 `_.gte(x).and(_.lt(y))`（gotcha #1/#9）。
4. **owner 隔离**：每个读/写查询都带 `openid`（非微信上下文才回退 anonymous）。
5. **纯函数可测**：正则层、OCR 解析层抽到 `utils/` / `parseOcr.js`，与 SDK 解耦，便于 jest/node:test 直接 require。
6. **单一数据源派生**：分类词库改一处，相关正则/映射自动派生，不手写副本。
7. **硬规则兜底**：正则命中即强制执行业务动作，模型只做兜底，杜绝幻觉入库。
8. **不静默入库脏数据**：OCR 失败返回错误码（`AI_CALL_ERROR` 等），前端提示"识别失败请手动记"，绝不假成功。
9. **改云函数必须重新部署**（本地改 ≠ 线上跑新版），用 CloudBase MCP `updateFunctionCode`（gotcha #9）。
10. **视觉 OCR 走 DeepSeek OpenAI 兼容 API**：`https://api.deepseek.com/chat/completions`，API Key 走环境变量 `DEEPSEEK_API_KEY`（不硬编码），默认模型 `deepseek-chat`，可用 `DEEPSEEK_MODEL` 环境变量覆盖（如线上 `deepseek-flash`）。**绝不用 `hunyuan-2.0-instruct`(hy3)**——它是纯文本，传图被忽略→幻觉错值（gotcha #10/#12，根因仍成立）。原 cloudbase 组 `qwen3.5-plus`/`glm-5v-turbo` 方案因个人版套餐限制/网关 400 已弃用，见 GOTCHAS.md `[GOTCHA-2026-08-01-001]` 2026-10-01 更新标注。

---

## 5. 测试

### 5.1 两套测试

| 套件 | 运行 | 覆盖 | 依赖 |
|---|---|---|---|
| **Jest**（ci-tools） | `cd ci-tools && npx jest` | 意图路由 / 云函数 / 多轮上下文 / 页面集成 / 月边界 / OCR | `wx-server-sdk` mock（`__mocks__`） |
| **node:test**（miniprogram/utils/__tests__） | `node miniprogram/utils/__tests__/*.test.js` | 纯函数（fallbackHint/dateRange/deleteResult/parseExpense） | 零依赖 |

> 当前用例数：Jest ~184+，node:test 83（README 标注；以实际跑数为准）。

### 5.2 关键 mock 机制

- `ci-tools/__mocks__/wx-server-sdk.js`：内存 store + `cloud.__reset(store, ctx)` 控制数据库与 OPENID。支持 `_.gte/.lt/.gt/.lte/.eq` 及 `$and/$or` 嵌套（**新增 command 操作如 `.in/.elemMatch` 需在 mock 同步实现**）。
- `agent-ui-stub.js` / `cloudbase-node-sdk-stub.js`：组件/SDK 桩。
- 云函数源码 `require('../../cloudfunctions/miaojiRecord/index.js')` 直接被测试 require，`wx-server-sdk` 经 `moduleNameMapper` 重定向到 mock。

### 5.3 怎么加用例

- **纯函数改动**（parseExpense / fallbackHint / dateRange / deleteResult）：在 `miniprogram/utils/__tests__/` 对应 `*.test.js` 加 `test(...)`，直接 `node` 跑验证。
- **云函数/意图链路改动**：在 `ci-tools/tests/` 加 `describe` 块。`miaojiRecord.test.js` 已含 add/list/delete/summary/stats/range/月边界/owner 隔离等套件，**新增 action 必加对应 describe**。
- **OCR 配置守卫**：`tests/parseOcr.test.js` 断言 `index.js` 含 `api.deepseek.com/chat/completions` 且**不含** `hunyuan-exp`/`hunyuan-2.0-instruct`（纯文本会视觉幻觉），并断言从 `process.env.DEEPSEEK_API_KEY` 读取 Key（防硬编码）。防有人改回纯文本模型或把 Key 写进代码。

### 5.4 真 OCR 回归（不进 jest 默认套件）

```bash
# 前置：装 tcb CLI + 登录
npm i -g @cloudbase/cli && cloudbase login
node ci-tools/scripts/realOcrTest.js            # 读 fixture → 调 visionProbe → 断言
node ci-tools/scripts/realOcrTest.js --prompt old   # 对比旧 prompt
node ci-tools/scripts/realOcrTest.js --strict       # CI 严格模式（失败 exit 1）
```
- fixture：`ci-tools/fixtures/alipay_bill_detail.jpg`（永久基线，git 跟踪）。
- 断言：amount≈76.80 / category∈{娱乐,其他} / date 含 `2026-07-31` / merchant 含「影城」。

---
### 5.5 已覆盖的测试用例边界（改代码前必读 ⚠️）

> 这些是**现有测试已守护的边界**。改对应逻辑时，先跑相关套件确认没破坏；新增边界必须补用例。

#### A. 云函数 `miaojiRecord`（Jest · `miaojiRecord.test.js`）
| 边界 | 覆盖点 |
|---|---|
| **add 金额符号** | 负金额→expense；正金额→income；缺省分类→「其他」 |
| **add 非法输入** | `amount:'abc'` → `INVALID_AMOUNT` |
| **add 无 OPENID** | 回退 `anonymous` 且能写入 |
| **list 倒序 / 截断** | 最近 N 笔倒序；`limit>200` 截断到 200 |
| **list owner 隔离** | 只返回自己记录，他人不可见 |
| **list 月边界（北京时间）** | `month:'this'` 不含上月末（修复 7/31 误入 8 月本月）；起点为本月 1 号 0 点（北京时间）；`month:'YYYY-MM'` 精确跨年（2025-01 / 2026-01 互不串）；`startDate+endDate` 含两端当天、`_.lt(end)` 排除次日 0 点后；`days` 滚动窗口兜底（40 天前排除） |
| **delete** | 删指定 `_id` → `removed:1`；缺 `_id` → `MISSING_ID` |
| **summary** | 今日/本月 income/expense 带符号（expense 负 income 正）；未知 action → `UNKNOWN_ACTION` |
| **stats 聚合** | 按分类聚合（餐饮 -80 / 交通 -20）；净=收入+支出；`byCategory` 按绝对值排序；指定分类只返该分类；owner 隔离（他人 0 笔） |
| **stats range** | `startDate~endDate` year 模式只统该年（含收入/支出）；between 含两端当天；lastN 由前端算区间、云函数只认区间边界含 endDate 当天 23:59:59；range 下 owner 隔离仍生效 |
| **端到端 T3** | `午饭花了38块`→解析→add 落库→list 能查到；`收到工资8000`→income；闲聊→不触发记账、库不新增 |

#### B. 端侧正则 `parseExpense` / `parseQuery`（node:test · `parseExpense.test.js` + Jest `PQ`）
| 边界 | 覆盖点 |
|---|---|
| **基础消费识别** | `午饭38块`→餐饮 -38；`打车45`→交通 -45；`买衣服200元`→购物 -200；`收到工资8000`→收入 +8000 |
| **无金额/无意图** | `今天天气不错`→null；`我的幸运数字是7`→null（不误记） |
| **品牌词无单位** | `滴滴17.7`、`taxi 17.7`（中英混合）→交通 -17.7；纯 `滴滴` / `滴滴abc` / 裸 `17.7`→null（不误触） |
| **多笔解析** | `午饭38，滴滴17.7`→两笔（餐饮+交通）；`滴滴17.7 打车25.5`→两笔交通 |
| **查询意图 PQ** | 本月→month；今年/去年/指定年→range/year；最近30天/近一周→range/lastN；上半年/1月到6月→range/between；含金额（"午饭花了38块"）→null（是记账不是查询）；闲聊→null |
| **B1 误记防护** | **应记**：`奖金500`/`午饭38`/`早餐25`/`发工资100`/`工资100`/`分红2000`（类目词/收入词即意图，无单位也记）；**不记**：`墙高3块砖`/`股价跌了5块`/`第3名奖金`/`房间38度`/`离终点2公里`/`我身高180`/`第38名`（排名/温度/尺寸/裸数字/量词组合一律 null） |

#### C. 意图路由 `classifyIntent`（Jest · `extractByModel.test.js`）
| 边界 | 覆盖点 |
|---|---|
| **模型输出解析** | 裸 JSON；` ```json ``` ` 代码块包裹；收入正数；query 本月/分类/breakdown |
| **JSON 容错** | 杂讯里抠第一个 `{..}`；多行 JSON 含换行；空串/null/undefined→null |
| **validateRecord** | 金额超 `MAX_ABS_AMOUNT=1e7`/零/NaN→退化 chat；`amount:null`→被动填槽 |
| **白名单校验** | 非法 category→回退「其他」；非法 query type→回退 month |

#### D. 拍照 OCR（`photoAccount.test.js` + `parseOcr.test.js`）
| 边界 | 覆盖点 |
|---|---|
| **OCR 全流程 A2** | 拍照→uploadFile→callFunction(ocr)→**确认弹窗出现但暂不记账**（add 未被调）；用户确认→`onOcrConfirm`→doAdd 被调且金额/类别/商家正确、对话流出现 `[已记]` |
| **OCR 失败分支** | 识别失败→弹窗不出现 / toast 提示，绝不假成功静默入库（见 gotcha #8） |
| **parseOcrResponse 容错** | 正常 JSON；` ```json ``` ` 剥离；非法 category→「其他」；`amount` 为字符串/缺失→null（触发手动补）；merchant 缺失→空串；多行 JSON |
| **⚠️ 模型配置守卫** | `index.js` 必须含 `api.deepseek.com/chat/completions`、**禁止** `hunyuan-2.0-instruct` / `hunyuan-exp`（纯文本会视觉幻觉）、Key 必须来自 `process.env.DEEPSEEK_API_KEY`（不硬编码）；必须支持 base64 data-URL 直传 |

#### E. 其他纯函数（node:test）
- `dateRange.test.js`：`computeCurrentMonthDays()` 边界
- `deleteResult.test.js`：`checkDeleteResult()` 三态（ok / not-found / fail）
- `fallbackHint.test.js`：模型失败时的反问/万能提示

> **统计口径红线**：所有"月/年"边界测试都按**北京时间**构造（`TZ_OFFSET=8h`）。改 `toUtcMidnight` / `list` / `stats` 后必跑 `miaojiRecord.test.js` 的月边界 + range 套件，确认"本月支出"不为 0、跨年/跨月不串数据。

---

## 6. 部署流程

### 6.1 前端（小程序）

```bash
# 预览二维码（需 .env 配 APPID + PRIVATE_KEY_PATH）
node ci-tools/compile.js preview
# 上传体验版
node ci-tools/compile.js upload
```
> `compile.js` 走**方案 A2**：上传前用 babel 把 `miniprogram/` 转译成 ES2019 兼容副本（`.build/miniprogram/`），绕开微信后台老 parser 不认可选链 `?.` 的限制（gotcha #11）。源码不动。

### 6.2 云函数 `miaojiRecord`（业务函数）

**用 CloudBase MCP**：`manageFunctions(action=updateFunctionCode, functionRootPath=<项目根>/cloudfunctions, functionName=miaojiRecord)`。
> ⚠️ 不要用 `uploadCloudFunction.sh`（只部署 demo 的 quickstartFunctions）。
> ⚠️ 改完必重新上传；线上跑的是上传的版本，不是本地文件。
> ⚠️ 部署后有冷启动缓存，首次 invoke 可能跑旧实例，需二次 invoke 验证才是真新版（gotcha #15）。

### 6.3 配置切换（换自己的环境）

改两处：
- `miniprogram/app.js`：`wx.cloud.init({ env: "你的env" })`
- `miniprogram/pages/chatBot/chatBot.js`：`modelConfig`（provider=cloudbase, model=hy3 用于意图判断）

---

## 7. 仓库卫生（git 状态备注）

当前工作区有未跟踪的临时文件：`b64_oneline.txt`、`test_img_b64.txt`（OCR 调试用 base64 串，非源码）。
- 这些**不要提交**（属临时产物）。
- 根目录大量 `*.TODO.md` / `*.log` 是迭代过程记录，可酌情清理或保留作历史参考。
- `ci-tools/*.log` / `qrcode-*.png` / `preview_qr.png` 是编译/预览产物，已在 `.gitignore` 或应忽略。
- 最新业务 commit：`01e787f`（大模型分类兜底 + travelRecord 同步地理编码重构）已涵盖近期修复。

---

## 8. 给迭代者的常见任务标准做法

| 任务 | 标准动作 |
|---|---|
| **加一个新消费分类** | 改 `parseExpense.js` 的 `CATEGORY_KEYWORDS`（加一类 + 关键词）→ 派生自动生效 → 同步 `extractByModel.js` 的 `VALID_CATEGORIES` → 跑 `parseExpense.test.js` + `extractByModel.test.js` |
| **修意图识别误判** | 先在 `parseExpense.js` / `extractByModel.js` 定位（正则漏抽 or 模型判错）→ 正则层改 `CATEGORY_KEYWORDS`/`UNDO_RE`/`parseDateHint` → 模型层改 `buildPrompt` → 加回归用例 |
| **改月/年统计口径** | 改云函数 `list`/`stats` 的 `toUtcMidnight` + 前端 `records.js`/`chatBot.js` 的 `month:'this'` → 跑 `miaojiRecord.test.js` 月边界套件 |
| **调 OCR 识别质量** | 改 `miaojiRecord/index.js` 的 `extractFromImage` prompt → 跑 `realOcrTest.js`（真图回归）→ 确认守卫测试仍过（`qwen3.5-plus` 未被换） |
| **加新云函数 action** | `index.js` 的 `switch` 加 case + 对应单测 describe → CloudBase MCP 重新部署 → 二次 invoke 验证 |
| **前端加页面/组件** | `app.json` 注册 → 四件套 `.js/.json/.wxml/.wxss` → `compile.js dev-check` 校验结构 |

---

## 9. 必读 gotcha 速查（详见 `GOTCHAS.md` / `MEMORY.md`）

| # | 坑 | 一句话 |
|---|---|---|
| 1 | CloudBase `.where()` 链式覆盖 | 多字段合并单对象，范围用 `_.gte().and(_.lt())` |
| 9 | 改云函数必须重传 | 本地改 ≠ 线上跑新版；用 MCP `updateFunctionCode`；二次 invoke 验证 |
| 10/12 | 视觉 OCR 模型选型 | `qwen3.5-plus` 可用；hy3 纯文本会幻觉；flash 400；glm-5v 个人版未启用 |
| 11 | miniprogram-ci 不支持 `?.` | `compile.js` 上传前 babel 转译（ES2019） |
| 14 | 时区错位致统计全 0 | 月/日边界按北京时间 `TZ_OFFSET` 构造 |
| 15 | 金额浮点长尾 | 全量 `round2`；前端用 `xxxText` 字符串 |
| 16 | WXML 不支持方法调用 | `.toFixed()` / `?.` 进不了 wxml；JS 层预格式化 |

---

## 10. 旅游记录模块（travelRecord）

> 独立于记账模块，代码/数据/云函数全隔离，不互相影响。

### 10.1 数据模型

| 集合 | 说明 | 关键字段 |
|---|---|---|
| `trips` | 旅程 | `_openid`, `title`, `startDate`, `endDate`, `location`, `cover`, `summary`, `entryCount`, `photoCount`, `createdAt` |
| `trip_journals` | 日记 | `_openid`, `tripId`, `day`, `date`, `time`, `title`, `location`(含 `lat/lng` 坐标), `content`, `photos[]`, `createdAt` |

索引：`trips` = `(_openid, createdAt desc)`；`trip_journals` = `(_openid, tripId, day asc, time asc)`。

### 10.2 云函数 `travelRecord`

**独立函数**，不依赖 `miaojiRecord` 的任何代码。
- `functionRootPath`: `cloudfunctions/` → 自动识别 `travelRecord/` 子目录
- 入口：`index.main`，按 `event.action` 分发
- 所有写操作（addJournal/saveMultiDay 等）**自动触发相邻地点驾车距离计算**（同步，`computeDistances` 内嵌地理编码，不静默异步）

| action | 参数 | 说明 |
|---|---|---|
| `createTrip` | `title, startDate, endDate, cover, location, summary` | 创建旅程 |
| `updateTrip` | `tripId, title, cover, startDate, endDate, location, summary` | 更新旅程 |
| `deleteTrip` | `tripId` | 删除旅程（级联删除所有日记） |
| `listTrips` | `page, limit` | 旅程列表（倒序） |
| `getTrip` | `tripId` | 旅程详情 + 所有日记（按 day/time 正序） |
| `addJournal` | `tripId, day, date, time, title, location, content, photos` | 新增日记（自动更新旅程 entryCount/photoCount，触发相邻距离计算） |
| `updateJournal` | `journalId, day, date, time, title, location, content, photos` | 更新日记 |
| `deleteJournal` | `journalId` | 删除日记（自动更新旅程统计） |
| `listJournals` | `tripId, sort` | 获取旅程的所有日记 |
| `parseNaturalLanguage` | `text` | AI 自然语言解析（deepseek-v4-flash），提取日期/时间/标题/地点/内容 |
| `parseMultiDay` | `text` | AI 批量解析多日行程（返回 JSON 数组，不走数据库） |
| `saveMultiDay` | `tripTitle, tripStartDate, tripEndDate, tripLocation, journals` | 批量保存多日行程（自动创建旅程 + 写入日记 + 同步触发相邻距离计算） |
| `geocode` | `address` | 地理编码（包装 `smartGeocode`，自动判断城市 + 腾讯地图 API + AI 兜底坐标） |
| `calcDistance` | `from, to` | 驾车距离计算（腾讯地图路线规划 API） |

> **关键设计**：`computeDistances` 是同步的——先对无坐标的 location 执行 `smartGeocode`（AI 判断城市→腾讯地图 API→AI 兜底坐标），坐标回写数据库后，再调用腾讯地图驾车路线 API 算相邻距离。`saveMultiDay` 和 `addJournal` 都同步触发，不异步。`smartGeocode` 与 `geocode` 共享同一套逻辑（`geocode` 是对 `smartGeocode` 的简单包装）。

### 10.3 前端页面（独立于记账页）

| 页面 | 文件名 | 职责 |
|---|---|---|
| 旅程列表 | `pages/travelList/` | 主页入口，展示所有旅程卡片 |
| 旅程详情 | `pages/tripDetail/` | 时间线视图，按 Day 分组展示日记 |
| 日记编辑 | `pages/journalEdit/` | 语音输入/文字/照片/地图选点(含坐标) |
| 旅程编辑 | `pages/tripEdit/` | 新建/编辑旅程基本信息 |

### 10.4 首页入口

在 `pages/index/index.wxml` 的 CTA 记账按钮和最近记录之间，插入独立的紫色渐变卡片「🧳 旅途记录」。点击 → `navigateTo` 跳转 `travelList`，不走记账路由。

### 10.5 地点方案（推荐）

使用微信原生 API `wx.chooseLocation()`：
- **地图选点**：用户在地图上选点或搜索，返回 `name/address/latitude/longitude`
- **坐标持久化**：日记的 `location` 字段存 `{name, address, latitude, longitude}`
- **导航跳转**：后续可调用 `wx.openLocation({latitude, longitude})` 直接跳转地图APP导航
- **无需额外配置**：小程序基础库自带，无需引入第三方SDK

### 10.6 语音输入

使用已配置的 WechatSI 插件（`app.json` 已注册 `WX_PROVIDER_APPID_PLACEHOLDER`）：
- 前端 `plugin.getRecordRecognitionManager()` 录音 → 转文字
- 通过 `parseNaturalLanguage` 云函数 AI 解析（deepseek-v4-flash）
- 解析结果自动填充日期/时间/标题/地点/内容各字段

### 10.7 部署

```bash
# 云函数首次部署已在 MCP 完成
# 后续更新代码后：
# CloudBase MCP → manageFunctions(updateFunctionCode, functionRootPath=cloudfunctions, functionName=travelRecord)

# 前端更新后：
# 编译上传：node ci-tools/compile.js upload
```

### 10.8 注意事项

- 照片上传到云存储 `travel/` 路径，与 `miaojiRecord` 的 `ocr_tmp/`、`avatars/` 互不干扰
- 日记的 `day` 字段自动根据旅程 `startDate` 计算，也可手动调整
- 快速记录模式（`mode=quick`）无需先建旅程，系统自动创建名为「{地点名}之旅」的旅程
- 无 `travelRecord` 相关 Jest 测试用例（TODO：后续可加）
