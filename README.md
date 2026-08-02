# 秒记账 (MiaoJi)

> 说话即记账的 AI 记账微信小程序。基于腾讯云开发（CloudBase）+ 大模型，用户用自然语言说出消费，AI 自动识别金额、分类并保存。

> 📘 **Agent 迭代手册**：涉及改代码 / 部署 / 测试，请先读 [`project.md`](./project.md)（文件职责、编码习惯、数据流、部署坑、常见任务标准做法、gotcha 速查）。

## 项目一句话

**秒记账** = 微信小程序 + 云开发（CloudBase）大模型 + 记账云函数。首页展示收支汇总与最近记录，对话页用自然语言记账 / 查询，意图理解全部在端侧完成。

## 功能

- 💬 **对话记账**：说"午饭花了38块"，自动识别金额 + 分类（餐饮）入库
- 🧾 **一句话多笔记账**（已上线）：说"早饭12，午饭38，晚饭45"一次性记多笔；正则只抽线索，最终由模型判金额 / 分类 / 归属（处理 AA 等复杂归因）
- 🔍 **自然语言查询**（已上线）：
  - "这个月花了多少" → 月总览（支出 / 收入 / 净 + 分类 Top + 逐笔明细）
  - "餐饮花了多少" → 单类查询
  - "按分类统计支出" → 全部分类分布
  - "收入有多少" → 收入汇总 + 真实收入明细
  - "最近记了啥" → 最近 8 笔
- 🔄 **多轮上下文**（已上线）：滑动窗口 10 轮原始对话，模型结合历史消解指代
  - "明细" → 延续上一轮（如收入明细）
  - "那支出呢" → 切到月总览
  - "6月呢" → 沿用上轮类型、换月份
  - "那笔最大的啥时候" → 跨轮指代（看历史里的具体记录）
- ✏️ **被动填槽**（已上线）："记一笔" → 追问金额/类别 → "38 餐饮" 自动补全记账
- ↩️ **撤回 / 更正**："记错了" 撤回最近一笔；"想起来错了，是60" 更正金额
- 📊 **首页汇总**：今日 / 本月收支 + 最近 5 笔，下拉刷新
- 🛡️ **误记防护**：裸数字（"我身高180""墙高3块砖"）不记账；含消费意图词（"午饭38"）才记
- 📷 **拍照记账**（已上线）：对话页浮动「拍照记账」按钮，选小票/发票/支付宝微信账单详情页后由云函数 `cloud.ai()` + `qwen3.5-plus` 多模态识别金额/商家/类别，弹出确认卡片（金额可改、**默认记为支出**、可一键切换收入/支出防错账）再入库。真 OCR 回归测试见 `ci-tools/scripts/realOcrTest.js`（fixture：`ci-tools/fixtures/alipay_bill_detail.jpg`）
- 👤 **登录 + 个人中心**（已上线）：进入自动静默登录（云函数 `login` 取 openid/unionid，落地 `users` 集合）；个人中心可改头像（chooseAvatar 上传 `avatars/`）/昵称、看本月汇总与笔数、退出登录
- 📋 **记账明细页**（已上线）：按**本月**（自然月，北京时间月边界，与查账面板口径一致）列出全部记录，支持编辑（金额/类别/备注/收入支出方向）与删除，数据按 openid 隔离

## 架构

**核心原则：模型先做意图判断，代码按 action 选分支执行。模型在一轮里只输出意图 JSON，绝不输出给用户看的散文——查到的数据由代码拼模板，零幻觉。**

```
用户输入
  ↓ parseExpense / parseExpenses / parseQuery / parseUndo（正则抽线索，仅喂模型辅助）
  ↓ classifyIntent（大模型判意图，结合滑动窗口 history + 上一轮 ctx + 正则多笔线索）
  ↓ switch(action)：
      record       → miaojiRecord(add) + ✅ 卡片
      multi_record → miaojiRecord(add) × N + ✅ 多笔汇总卡片（模型逐条校验+归一）
      correct      → miaojiRecord(update 最近一笔) + ✅ 卡片
      query        → miaojiRecord(stats/summary/list) + 📊 模板（真实数据，代码生成）
      undo         → miaojiRecord(list+delete) + 🗑️ 卡片
      chat         → 放行 agent-ui 模型自由对话（唯一模型发声的分支）
```

### 记账判断逻辑详解（parseExpense.js）

端侧记账走「**正则抽线索 → 模型兜底判意图 → 硬规则强制执行**」三层防御，正则不落库、只喂模型辅助。

**① 分类单一数据源**
`CATEGORY_KEYWORDS`（餐饮/交通/购物/居家/娱乐/医疗/教育）是唯一的词库源。新增关键词只改这一处，`AMOUNT_PATTERNS`（金额提取正则）、`CATEGORY_MAP`（分类映射）、`INTENT_KEYS`（意图词）全部自动派生，杜绝"正则和分类词库不同步"导致的分类错乱（如早期 `地铁100` 被分为"其他"的 bug）。

**② 金额提取（extractAmount）**
逐条试 6 条 `AMOUNT_PATTERNS`，命中即返回数值：
1. 餐饮词 + 数字（`午饭38` / `午饭38元`）
2. 收入词 + 数字（`工资8000`）
3. 动作词 + 数字/单位（`花了38` / `付了50元`）
4. 交通/购物/… 类别词 + 数字/单位（`打车25` / `加油200`）
5. **中文数字** + 单位（`午饭五十` / `打车三十块`）→ `parseChineseAmount` 把 `五十→50`、`一百五→150` 转成数值（兜底 `parseFloat` 得 NaN 的场景）
6. 纯数字 + 单位（`38元` / `100块`）

**③ 分类判定**
`CATEGORY_MAP` 顺序匹配用户原话里的类别关键词，命中第一个即定类（餐饮优先于交通，故 `subway` 仅保留在交通避免被餐饮抢）。纯数字兜底路径（`matchesExpenseFallback`）覆盖白名单外新品类词（`谷子20`/`手办15`），归"其他"类。

**④ 日期识别（_date 字段）**
`parseDateHint(text)` 抽取相对日期，写入 `_date`（YYYY-MM-DD），交由云函数 `add` 的 `date` 参数落库：
- `昨天`/`前天`/`大前天`/`N天前` → 减 N 天
- `周一`~`周日` → 回退到最近一个该星期几
- `上周X` → 上一周的星期 X
- `上个月` → 上月同日（自动处理跨月/跨年天数回拨）
- 无日期词 → `_date: null`，云函数默认存当天

**⑤ 撤回意图（parseUndo）**
确定性正则 `UNDO_RE`，不调模型即时判定：`撤回|撤销|删掉|删除|取消记录|不要记了|别记了|退了重记|记错了|弄错了|搞错了|算错了|刚才那笔|刚刚那笔|上一笔不对|帮我撤了` 等。命中即走 `miaojiRecord(list+delete)`。

**⑥ 兜底盲区修复（e8f01ed）**
上述 4 类（过去日期、中文数字、英文/品牌别名、撤回词扩展）原为盲区，现已补齐并写入 `parseExpense.test.js`（83 用例全绿）。如再发现新盲区，优先在 `CATEGORY_KEYWORDS` / `UNDO_RE` / `parseDateHint` / `parseChineseAmount` 四处定点扩展，不要另起分支。

**为什么正则只做线索，不直接落库？** 一句话多笔 / AA 分账 / 混合句（如"午饭和同事AA花了76我付的"）的语义正则处理不了——这些必须靠模型做最终判定。`parseExpenses` 抽到的候选笔数喂给模型，模型返回 `multi_record` + records 数组（可修正正则的误分类 / 补归因），代码按模型结果批量落库。

**拍照记账分支**（对话页浮动按钮触发）：
```
选图 → wx.cloud.uploadFile(ocr_tmp/) → miaojiRecord(ocr, {imageUrl:fileID})
     → 云函数 cloud.ai() + qwen3.5-plus 多模态识别 → {amount,merchant,category,date}
     → 前端确认卡片（金额可改、默认支出、可切收入/支出） → miaojiRecord(add)
```

**登录分支**（app.js `onLaunch` 静默调用）：
```
miaojiRecord(login) → 取 openid/unionid，upsert users 集合
前端写缓存 userInfo → 个人中心 updateProfile 回写头像/昵称
```

**多轮上下文**：
- `_history`：最近 10 轮原始对话（`{role, text}`），每轮 `onUserSend`/`appendQueryMsg` 等维护
- `_ctx`：超出窗口的远处摘要（前段对话压缩），避免 context 爆炸
- `classifyIntent` 把 history 格式化成多轮对话给模型，教它消解指代 / 补全多轮记账

**为什么不在 agent 侧做？** 早期依赖 CloudBase Agent 后台配置 `miaojiRecord` 工具，链路长且不可控。现改为**前端直连 CloudBase 大模型（hy3）做意图判断**，云函数只做数据读写，逻辑全在代码里、可单测、可复现。

## 技术栈

- 微信小程序（原生，无 Taro/uni-app）
- **腾讯云开发（CloudBase）** + `wx.cloud` SDK
  - env: `seclog-d1g8no5pc45e643aa`（`ap-shanghai`）
- 对话 UI 复用 `components/agent-ui` 组件（bot 模式，直连大模型）
- 意图理解：`miniprogram/utils/extractByModel.js`（`classifyIntent` + prompt）
- 记账数据：`cloudfunctions/miaojiRecord/` 云函数（增 / 查 / 删 / 汇总 / 统计）
- 本地测试：`ci-tools/`（Jest，184+ 用例全绿，覆盖意图路由 / 云函数 / 多轮上下文 / 页面集成 / 月边界）
- 基础库最低 `3.8.1`，本地推荐 `3.16.2`（见 `project.private.config.json`）

## 目录结构

```
SecLog/                          ← 项目根（微信开发者工具打开此目录）
├── miniprogram/                 ← ⭐ 小程序代码（已纳入 git 版本控制）
│   ├── pages/
│   │   ├── index/              ← 首页：品牌 + 收支汇总 + 最近记录 + 入口
│   │   ├── chatBot/            ← 记账对话页（agent-ui 组件，bot 模式）+ 拍照记账浮动按钮
│   │   │   └── chatBot.js      ← ⭐ 意图路由 + 多轮上下文 + 查询模板 + 拍照 OCR 确认流（核心）
│   │   ├── guide/              ← 使用引导页（独立入口）
│   │   ├── profile/            ← 个人中心：头像/昵称/本月汇总/退出登录
│   │   └── records/           ← 记账明细：列表 + 编辑 + 删除（本月，月边界与查账面板一致）
│   ├── components/
│   │   ├── agent-ui/           ← 对话主体组件（含工具卡片渲染）
│   │   └── toolCard/           ← 地图/天气/商家等工具卡（agent-ui 依赖，勿删）
│   ├── utils/
│   │   ├── extractByModel.js   ← ⭐ classifyIntent：大模型意图判断（含多轮 history）
│   │   ├── parseExpense.js     ← 正则抽金额/分类/查询/撤回（分层线索：CATEGORY_KEYWORDS 单一数据源 + 中文数字/品牌别名/过去日期/撤回词兜底）
│   │   ├── fallbackHint.js     ← 模型失败时的反问/万能提示生成
│   │   └── collectStreamText.js← 流式响应文本收集
│   ├── app.js / app.json / app.wxss
│   └── package.json / sitemap.json
├── cloudfunctions/
│   └── miaojiRecord/           ← ⭐ 记账云函数（add/list/delete/summary/stats/ocr/login/updateProfile，按 openid 隔离）
├── avatars/                     ← 用户头像（chooseAvatar 上传的云存储落地目录镜像，git 跟踪占位）
├── images/                      ← 小程序静态图（app-logo / default-avatar 等）
├── ci-tools/                   ← ⭐ 本地测试 + 编译（Jest + compile.js 出真机二维码）
│   ├── tests/                  ← 161 用例（意图路由 / 云函数 / 多轮 / 页面集成）
│   └── compile.js              ← 微信开发者工具 CLI 编译，生成真机预览二维码
├── project.config.json         ← 微信开发者工具项目配置
├── project.private.config.json ← 本地私有配置（不提交）
├── uploadCloudFunction.sh       ← 云函数部署脚本
└── README.md
```

## 启动步骤

1. 安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 用开发者工具打开 `D:\Project\SecLog\` 整个目录
3. 在 `project.private.config.json` 填入你的小程序 `appid`（仓库默认 hardcode 测试 appid `WX_OWN_APPID_PLACEHOLDER`）
4. 编译运行

## 本地测试

```bash
cd ci-tools
npx jest            # 跑全量 161 用例（意图路由 / 云函数 / 多轮上下文 / 页面集成）
npx jest tests/extractByModel.test.js   # 单文件
```

> **mock 提示**：`__mocks__/wx-server-sdk.js` 用普通对象 + 函数方法模拟 CloudBase command 对象的链式调用（`_.gte(v).and(_.lt(e))`），支持 `$gte`/`$lt`/`$and` 复合条件。如果新增云函数用了其他 command 操作（如 `.in`/`.elemMatch`），需在 mock 里同步实现。

出真机预览二维码（需微信开发者工具 CLI）：

```bash
node ci-tools/compile.js preview
```

## 云函数部署

```bash
# 安装 CloudBase CLI（一次性）
npm i -g @cloudbase/cli

# 部署（项目脚本，含自检）
./uploadCloudFunction.sh
```

`miaojiRecord` 已通过 CloudBase MCP 部署至 env `seclog-d1g8no5pc45e643aa`，改代码后需重新上传（本地改了 ≠ 线上跑新版）。

## 配置说明

- **云环境**：`miniprogram/app.js` 中 `wx.cloud.init({ env: "seclog-d1g8no5pc45e643aa" })`
- **大模型**：`miniprogram/pages/chatBot/chatBot.js` 的 `modelConfig`（provider=cloudbase, model=hy3）
- **切换自己的环境**：改 `app.js` 的 env + `chatBot.js` 的 modelConfig 即可

## 已知状态

| 项 | 状态 |
|---|---|
| `miniprogram/` 版本控制 | ✅ 已纳入 git |
| 记账后端 | ✅ `miaojiRecord` 云函数 + `miaoji_records` 集合已上线 |
| 意图路由（record/multi_record/query/undo/correct/chat） | ✅ 前端 classifyIntent 完成 |
| 一句话多笔记账（multi_record） | ✅ 已上线（正则抽线索 + 模型最终判定） |
| 多轮上下文（滑动窗口 10 轮 + 远处摘要） | ✅ 已上线 |
| 被动填槽（记一笔→追问→补全） | ✅ 已上线 |
| 本地测试 | ✅ 161 用例全绿 |
| 意图识别分层（正则优先 + 模型兜底） | ✅ 已上线（1.0.9） |
| 分类明细（"餐饮明细"只显示该类别） | ✅ 已上线（1.0.9） |
| 拼音/英文输入识别（newnew100） | ✅ 已上线（1.0.6） |
| 模型降级失败行为（不反问，直接执行） | ✅ 已上线（1.0.7） |
| 拍照记账 | ✅ 已上线（云函数 cloud.ai() + qwen3.5-flash 多模态识别） |
| 登录 + 个人中心 | ✅ 已上线（静默登录 + users 集合 + 头像/昵称编辑） |
| 记账明细页 | ✅ 已上线（列表 / 编辑 / 删除，openid 隔离） |
| `quickstartFunctions` | 🟡 早期压测 demo，与产品无关，可删 |

## 文档参考

- [腾讯云开发文档](https://docs.cloudbase.net/)
- [微信小程序文档](https://developers.weixin.qq.com/miniprogram/dev/framework/)
- [CloudBase Agent](https://docs.cloudbase.net/ai/agent)

---

## ⚠️ 部署提醒（改完必看）

- **云函数改完必须重传**：`miaojiRecord` 的 `ocr`/`login`/`updateProfile` 是新增 action，已在 `seclog-d1g8no5pc45e643aa` 环境部署过；但**本地改了 ≠ 线上跑新版**，每次改云函数代码都要 `./uploadCloudFunction.sh` 重新上传（见「云函数部署」一节）。
- **意图识别硬规则（1.0.7 起）**：正则命中 `regexExpense`/`queryHint`/`undoHint` 时，**无论模型说什么/是否失败，都强制执行对应操作**（doAdd/tryQuery/tryUndo）。目的是杜绝"模型幻觉已记账但代码没写库"；模型角色从唯一决策者变为"正则未覆盖场景的兜底"。
- **wx-server-sdk 版本**：`cloud.ai()` 通道需要 `wx-server-sdk >= 3.x`，老版本 2.6.3 无此 API，会在 `ocr` 时返回 `AI_UNAVAILABLE`。
- **前端静默登录**：`app.js` 在 `onLaunch` 调 `miaojiRecord(login)`；若未部署 `login` action，个人中心会拿不到 openid 但记账仍按 openid 隔离正常工作。
- **分类明细**：1.0.9 起"餐饮明细"只显示餐饮类记录（之前返回全部类别，是 bug）。
- **multi_record 与正则的边界**：`parseExpense.js` 必须导出 `parseExpenses`（之前漏导出导致 `parseExpenses is not a function`），且 `classifyIntent` 的 `opts` 必须解构 `regexExpenses`（之前漏解构导致 `ReferenceError` 被 catch 吞掉、整条链路静默返回 null）。改这两块时务必跑 `tests/extractByModel.test.js` 验证。

## 🧪 真 OCR 集成测试（拍照记账 prompt 回归）

`jest` 的 `photoAccount.test.js` 只 mock OCR（不调真模型），无法验证"改了 prompt 后真能识别支付宝 UI 截图"。要跑**真 OCR**，用独立脚本：

```bash
# 前置：装 tcb CLI + 登录（只需一次）
npm i -g @cloudbase/cli
cloudbase login            # 扫码登录

# 跑真 OCR 测试（读 fixture → 调 visionProbe → 断言）
node ci-tools/scripts/realOcrTest.js

# 对比：用旧 prompt（"识别这张小票..."）跑同一张图，看修复前后差异
node ci-tools/scripts/realOcrTest.js --prompt old

# CI 严格模式（失败 exit code 1）
node ci-tools/scripts/realOcrTest.js --strict
```

- **fixture**：`ci-tools/fixtures/alipay_bill_detail.jpg`（支付宝账单详情页，git 跟踪，作为永久回归基线）
- **云函数**：`visionProbe`（`cloudfunctions/visionProbe/index.js`）接受 `imageUrl` + `prompt` 参数，已部署到 `seclog-d1g8no5pc45e643aa`
- **断言**：`amount≈76.80` / `category∈{娱乐,其他}` / `date` 含 `2026-07-31` / `merchant` 含「影城」——验证新 prompt 正确忽略干扰项（时间数字、积分、抵扣券、状态文字），从「商品说明」字段取商家
- **费用**：每次调用约 4-15s + 模型 token（生产 CloudBase 资源包已购，按需计费）
- **注意**：脚本**不进 jest 默认套件**（避免每次跑单测都烧 token + 依赖云凭证）。手动跑或 CI 可选门控。
