# 秒记 (MiaoJi)

> 说话即记账的 AI 记账微信小程序。基于腾讯云开发（CloudBase）+ 大模型，用户用自然语言说出消费，AI 自动识别金额、分类并保存。

## 项目一句话

**秒记** = 微信小程序 + 云开发 Agent + 记账云函数。首页展示收支汇总与最近记录，对话页用自然语言记账，引导页讲清怎么用。

## 功能

- 💬 **对话记账**：说"午饭花了38块"，自动识别金额 + 分类（餐饮）入库
- 📊 **智能汇总**：首页实时展示今日 / 本月支出
- 📝 **最近记录**：首页展示最近 5 笔，下拉刷新
- 📷 **拍照记账**（规划中）：上传小票，AI 提取金额与商家
- 🔍 **自然语言查询**（规划中）："这个月餐饮花了多少" → 即时回答

## 技术栈

- 微信小程序（原生，无 Taro/uni-app）
- **腾讯云开发（CloudBase）** + `wx.cloud` SDK
  - env: `seclog-d1g8no5pc45e643aa`（`ap-shanghai`）
- 云开发 Agent（`bot-e7d1e736`）+ 云函数 `miaojiRecord` 完成记账数据读写
- 对话 UI 复用 `components/agent-ui` 组件
- 基础库最低 `3.8.1`，本地推荐 `3.16.2`（见 `project.private.config.json`）

## 目录结构

```
SecLog/                          ← 项目根（微信开发者工具打开此目录）
├── miniprogram/                 ← ⭐ 小程序代码（已纳入 git 版本控制）
│   ├── pages/
│   │   ├── index/              ← 首页：品牌 + 收支汇总 + 最近记录 + 入口
│   │   ├── chatBot/            ← 记账对话页（agent-ui 组件，bot 模式）
│   │   └── guide/              ← 使用引导页（独立入口）
│   ├── components/
│   │   ├── agent-ui/           ← 对话主体组件（含工具卡片渲染）
│   │   └── toolCard/           ← 地图/天气/商家等工具卡（agent-ui 依赖，勿删）
│   ├── app.js / app.json / app.wxss
│   └── package.json / sitemap.json
├── cloudfunctions/              ← 云函数目录
│   ├── miaojiRecord/           ← ⭐ 记账云函数（增/查/删/汇总）
│   └── quickstartFunctions/    ← 早期压测 demo（可删）
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

## 云函数部署

```bash
# 安装 CloudBase CLI（一次性）
npm i -g @cloudbase/cli

# 部署（项目脚本，含自检）
./uploadCloudFunction.sh
```

脚本可覆盖环境变量：`ENV_ID` / `PROJECT_PATH` / `INSTALL_PATH`（详见脚本内注释）。

`miaojiRecord` 已通过 CloudBase MCP 部署至 env `seclog-d1g8no5pc45e643aa`，无需本地再部署即可运行。

## 记账数据流

```
用户说话 → chatBot(agent-ui) → CloudBase Agent(bot-e7d1e736)
         → 调用 miaojiRecord 云函数 → 读写 miaoji_records 集合（按 openid 隔离）
首页 onShow → 直接调用 miaojiRecord(summary / list) → 展示汇总与最近记录
```

> ⚠️ **要使对话真正记账**，需在 CloudBase 控制台为 `bot-e7d1e736` 配置调用 `miaojiRecord` 云函数的工具（agent 侧工具绑定不在这份代码里）。前端 UI 已就绪，配好即生效。

## 配置说明

- **云环境**：`miniprogram/app.js` 中 `wx.cloud.init({ env: "seclog-d1g8no5pc45e643aa" })`
- **Agent**：`miniprogram/pages/chatBot/chatBot.js` 的 `agentConfig.botId`
- **切换自己的环境**：改 `app.js` 的 env + `chatBot.js` 的 botId 即可

## 已知状态

| 项 | 状态 |
|---|---|
| `miniprogram/` 版本控制 | ✅ 已纳入 git（原嵌套仓库 `.git` 已移除，commit `94026db`）|
| 记账后端 | ✅ `miaojiRecord` 云函数 + `miaoji_records` 集合已上线 |
| 对话记账可用性 | ⏳ 依赖 CloudBase 后台为 bot 配置 `miaojiRecord` 工具 |
| `quickstartFunctions` | 🟡 早期压测 demo，与产品无关，可删 |

## 文档参考

- [腾讯云开发文档](https://docs.cloudbase.net/)
- [微信小程序文档](https://developers.weixin.qq.com/miniprogram/dev/framework/)
- [CloudBase Agent](https://docs.cloudbase.net/ai/agent)

---

**最后更新**: 2026-07-13 — 转型为「秒记」AI 记账工具（后端 + 首页 + 引导页 + 对话改造），README 同步重写
