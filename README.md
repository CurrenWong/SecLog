# 秒记 (MiaoJi)

> 说话即记账的 AI 记账微信小程序。基于腾讯云开发（CloudBase）+ 大模型，用户用自然语言说出消费，AI 自动识别金额、分类并保存。

## 项目一句话

**秒记** = 微信小程序 + 云开发（CloudBase）大模型 + 记账云函数。首页展示收支汇总与最近记录，对话页用自然语言记账 / 查询，意图理解全部在端侧完成。

## 功能

- 💬 **对话记账**：说"午饭花了38块"，自动识别金额 + 分类（餐饮）入库
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
- 📷 **拍照记账**（已上线）：对话页浮动「拍照记账」按钮，选小票/发票后由云函数 `cloud.ai()` + `qwen3.5-flash` 多模态识别金额/商家/类别，弹出确认卡片（金额可改、默认不预填防错账）再入库
- 👤 **登录 + 个人中心**（已上线）：进入自动静默登录（云函数 `login` 取 openid/unionid，落地 `users` 集合）；个人中心可改头像（chooseAvatar 上传 `avatars/`）/昵称、看本月汇总与笔数、退出登录
- 📋 **记账明细页**（已上线）：按最近 30 天列出全部记录，支持编辑（金额/类别/备注）与删除，数据按 openid 隔离

## 架构

**核心原则：模型先做意图判断，代码按 action 选分支执行。模型在一轮里只输出意图 JSON，绝不输出给用户看的散文——查到的数据由代码拼模板，零幻觉。**

```
用户输入
  ↓ parseExpense / parseQuery / parseUndo（正则抽线索，仅喂模型辅助）
  ↓ classifyIntent（大模型判意图，结合滑动窗口 history + 上一轮 ctx）
  ↓ switch(action)：
      record   → miaojiRecord(add) + ✅ 卡片
      correct  → miaojiRecord(update 最近一笔) + ✅ 卡片
      query    → miaojiRecord(stats/summary/list) + 📊 模板（真实数据，代码生成）
      undo     → miaojiRecord(list+delete) + 🗑️ 卡片
      chat     → 放行 agent-ui 模型自由对话（唯一模型发声的分支）

**拍照记账分支**（对话页浮动按钮触发）：
```
选图 → wx.cloud.uploadFile(ocr_tmp/) → miaojiRecord(ocr, {imageUrl:fileID})
     → 云函数 cloud.ai() + qwen3.5-flash 多模态识别 → {amount,merchant,category,date}
     → 前端确认卡片（金额可改、默认不预填） → miaojiRecord(add)
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
- 本地测试：`ci-tools/`（Jest，141 用例，覆盖意图路由 / 云函数 / 多轮上下文）
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
│   │   └── records/           ← 记账明细：列表 + 编辑 + 删除（最近 30 天）
│   ├── components/
│   │   ├── agent-ui/           ← 对话主体组件（含工具卡片渲染）
│   │   └── toolCard/           ← 地图/天气/商家等工具卡（agent-ui 依赖，勿删）
│   ├── utils/
│   │   ├── extractByModel.js   ← ⭐ classifyIntent：大模型意图判断（含多轮 history）
│   │   ├── parseExpense.js     ← 正则抽金额/分类（辅助线索）
│   │   └── collectStreamText.js← 流式响应文本收集
│   ├── app.js / app.json / app.wxss
│   └── package.json / sitemap.json
├── cloudfunctions/
│   └── miaojiRecord/           ← ⭐ 记账云函数（add/list/delete/summary/stats/ocr/login/updateProfile，按 openid 隔离）
├── avatars/                     ← 用户头像（chooseAvatar 上传的云存储落地目录镜像，git 跟踪占位）
├── images/                      ← 小程序静态图（app-logo / default-avatar 等）
├── ci-tools/                   ← ⭐ 本地测试 + 编译（Jest + compile.js 出真机二维码）
│   ├── tests/                  ← 141 用例（意图路由 / 云函数 / 多轮 / 页面集成）
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
npx jest            # 跑全量 141 用例（意图路由 / 云函数 / 多轮上下文 / 页面集成）
npx jest tests/extractByModel.test.js   # 单文件
```

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
| 意图路由（record/query/undo/correct/chat） | ✅ 前端 classifyIntent 完成 |
| 多轮上下文（滑动窗口 10 轮 + 远处摘要） | ✅ 已上线 |
| 被动填槽（记一笔→追问→补全） | ✅ 已上线 |
| 本地测试 | ✅ 141 用例全绿 |
| 拍照记账 | ✅ 已上线（云函数 cloud.ai() + qwen3.5-flash 多模态识别） |
| 登录 + 个人中心 | ✅ 已上线（静默登录 + users 集合 + 头像/昵称编辑） |
| 记账明细页 | ✅ 已上线（列表 / 编辑 / 删除，openid 隔离） |
| `quickstartFunctions` | 🟡 早期压测 demo，与产品无关，可删 |

## 文档参考

- [腾讯云开发文档](https://docs.cloudbase.net/)
- [微信小程序文档](https://developers.weixin.qq.com/miniprogram/dev/framework/)
- [CloudBase Agent](https://docs.cloudbase.net/ai/agent)

---

**最后更新**: 2026-07-16 — 上线拍照记账（cloud.ai()+qwen3.5-flash 多模态）、登录+个人中心、记账明细页；品牌更名「秒记」→「秒记账」；README 同步更新

---

## ⚠️ 部署提醒（改完必看）

- **云函数改完必须重传**：`miaojiRecord` 的 `ocr`/`login`/`updateProfile` 是新增 action，已在 `seclog-d1g8no5pc45e643aa` 环境部署过；但**本地改了 ≠ 线上跑新版**，每次改云函数代码都要 `./uploadCloudFunction.sh` 重新上传（见「云函数部署」一节）。
- **wx-server-sdk 版本**：`cloud.ai()` 通道需要 `wx-server-sdk >= 3.x`，老版本 2.6.3 无此 API，会在 `ocr` 时返回 `AI_UNAVAILABLE`。
- **前端静默登录**：`app.js` 在 `onLaunch` 调 `miaojiRecord(login)`；若未部署 `login` action，个人中心会拿不到 openid 但记账仍按 openid 隔离正常工作。
