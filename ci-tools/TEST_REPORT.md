# 秒记（SecLog）自动化测试报告

> 生成日期：2026-07-14
> 测试框架：Jest 30 + miniprogram-simulate 1.6 + jsdom
> 测试总数：**69 passed / 69 total**（5 套件，0 失败）
> 运行命令：`cd ci-tools && npm test`

---

## 1. 测试分层架构

```
ci-tools/tests/
├── miaojiRecord.test.js    云函数单元 + 解析 + 端到端（T1/T2/T3 + B1）
├── extractByModel.test.js  大模型降级抽取（混合方案）
├── chatBot.test.js         确认消息归一 + 撤回意图 + 撤回端到端（逻辑层）
├── chatBotPage.test.js     页面实例集成 + 失败路径（A1/B2，真实源码）
└── weather.test.js         组件渲染（参考样例，验证 simulate 可用）
```

**mock 策略**
- `wx-server-sdk` → `ci-tools/__mocks__/wx-server-sdk.js`（内存数据库，支持 owner 隔离）
- `global.wx` → 测试内注入 `{ cloud: { callFunction }, showToast }`
- `global.Page` → 捕获页面配置，构造实例跑真实 `chatBot.js` 逻辑（miniprogram-simulate 不支持 `Page()`）
- 云函数 `callFunction` 返回值由测试用例精确控制（success / reject）

---

## 2. 各套件明细

### 2.1 miaojiRecord.test.js（26 用例）
| 分组 | 覆盖点 |
|---|---|
| **add** | 支出自动标记 expense / 收入自动标记 income / 缺省分类回退「其他」/ 非数字金额 INVALID_AMOUNT / 无 OPENID 回退 anonymous |
| **list** | 最近 N 笔倒序 / limit 超 50 截断 / **owner 隔离**（只返回自己） |
| **delete** | 按 _id 删除 / 缺 _id 返回 MISSING_ID |
| **summary** | 今日/本月 income-expense 汇总 / 未知 action → UNKNOWN_ACTION |
| **T2 解析** | 午饭38→-38餐饮 / 打车45 / 买衣服200 / 收到工资8000 / 闲聊 null / 纯数字 null |
| **B1 误记防护** | 奖金500元✓ / 墙高3块砖✗ / 股价跌5块✗ / 第3名奖金✗ / 38度✗ / 2公里✗ / 身高180✗ / 第38名✗ / 奖金500(无单位)✗ |
| **T3 端到端** | 解析→add 落库→list 查回 / 收入 / 闲聊不触发 |

### 2.2 extractByModel.test.js（14 用例）
- 模型返回裸 JSON / ```json 代码块 / 金额带 type 字段 / 分类白名单回落 / 金额超范围→null（防抽飞）
- **无记账意图→null**（amount:0 不误记）/ 非 JSON 垃圾→null / 调用抛错→null
- 混合链路：正则命中不调模型 / 正则 null 降级模型 / 两层都 null / 模型返回垃圾被校验拦截

### 2.3 chatBot.test.js（10 用例）
- **确认归一**：确定值"午饭38"→不含"大概/对吗" / 模糊值→带"大概的，对吗？" / 两层 null 不记账 / 确定值不调模型
- **parseUndo**："记错了/撤回/不对"命中 / 消费句不命中
- **撤回端到端**：记→撤→空 / 无记录安全 / **owner 隔离**（只删自己的）

### 2.4 chatBotPage.test.js（8 用例）
真实 `chatBot.js` 源码 + 页面实例语义：
- **A1 集成**：确定值→对话流出现 ✅ 卡片 + add 被调 + 未调模型 / add 失败→不插卡片+toast / 撤回意图走 tryUndo / 消费意图走 tryRecord
- **B2 失败路径**：网络 reject→不插卡片+「记账出错」/ list reject→「撤回出错」/ delete reject→「撤回出错」无卡片 / 正则 null+模型失败→**静默不记账**（无卡片无 toast）

### 2.5 weather.test.js（3 用例）
- 中文天气→英文图标名 / initWeather 填充 / 非 weather 不填充（simulate 框架可用性验证）

---

## 3. 关键修复（测试发现）

### 🐛 tryUndo 字段名 bug（严重）
`chatBot.tryUndo` 读取 `res.result.data` 取列表，但云函数 `list` 实际返回 `list` 字段。
**后果**：撤回功能完全失效（永远拿不到记录，误报"没有可撤回的记录"）。
**修复**：改为 `res.result.list`（与云函数及 chatBot.test 复刻逻辑一致）。
**发现路径**：A1 页面集成测试第一次跑就暴露（chatBot.test 之前复刻逻辑用了正确的 `list`，未覆盖真实源码笔误）。

---

## 4. 能力覆盖矩阵

| 能力 | 状态 | 测试 |
|---|---|---|
| 正则记账（确定值） | ✅ | T2/T3/A1 |
| 大模型降级抽取（模糊值） | ✅ | extractByModel 全组 |
| 确认消息归一（不双确认） | ✅ | chatBot.test |
| 模糊值核实语气 | ✅ | chatBot.test |
| 撤回（意图+删） | ✅ | chatBot.test + chatBotPage A1 |
| owner 隔离 | ✅ | miaojiRecord + chatBot.test |
| 误记防护（非消费数字） | ✅ | B1 |
| 失败兜底（网络/业务） | ✅ | A1 + B2 |
| 漏记优先于误记 | ✅ | B1（奖金500无单位→null） |

---

## 5. 运行与接入

```bash
cd ci-tools
npm test              # 跑全部 69 用例
npm test -- tests/chatBotPage.test.js --verbose   # 单套件
```

`package.json` 已配置 `"test": "jest --verbose"`。

---

## 6. 残余与后续

| 项 | 说明 | 优先级 |
|---|---|---|
| **Phase 2 真实云端联调** | 当前测试全用 mock，未触真云。需 CloudBase EnvId + 部署后联调 | 高 |
| 首页统计卡片 | 当前为纯对话式记账，无独立数字面板 | 中 |
| 多用户/家庭账本 | owner 隔离已支持，前端未做切换 UI | 中 |
| 模型抽取评测集扩充 | 更多模糊口语样本（方言/缩写） | 低 |

---

_报告由自动化测试体系生成。所有用例绿色，无跳过、无待定。_
