# SecLog

> 基于腾讯云开发（CloudBase）的微信小程序项目骨架。

## 项目一句话

演示 [腾讯云开发 Agent UI](https://docs.cloudbase.net/) 在微信小程序里的接入方式，包含 AI Agent 对话 + 大模型对话 + 工具调用能力展示。

## 技术栈

- 微信小程序（原生，无 Taro/uni-app）
- **腾讯云开发（CloudBase）** + `wx.cloud` SDK
  - 当前 env: `seclog-d1g8no5pc45e643aa`（`ap-shanghai` 体验版）
- AI Agent + 大模型（hunyuan / deepseek）双模切换
- base 库最低 `3.8.1`，本地推荐 `3.16.2`（见 `project.private.config.json`）

## 目录结构

```
SecLog/
├── miniprogram/           ← ⭐ 小程序代码（在 .git/info/exclude 里本地 ignore）
├── cloudfunctions/        ← 云函数目录（当前空，待加函数）
├── project.config.json         ← 微信开发者工具项目配置
├── project.private.config.json ← 本地私有配置（不提交）
├── uploadCloudFunction.sh       ← 云函数部署脚本
├── README.md                    ← 本文件
└── .gitignore                   ← Git 忽略规则
```

## 启动步骤

1. 安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 用开发者工具打开 `D:\Project\SecLog\` 整个目录
3. 在 `project.private.config.json` 里填入你的小程序 `appid`（默认在仓库里 hardcode 了测试 appid）
4. 编译运行

> ⚠️ **首次打开可能报"找不到云函数目录"**——因为 `cloudfunctions/quickstartFunctions/` 还没建。脚本会自动提示，或者你直接 `mkdir -p cloudfunctions/quickstartFunctions` 占位。

## 云函数部署

```bash
# 一次性安装
npm i -g @cloudbase/cli

# 部署（项目脚本，含自检）
./uploadCloudFunction.sh
```

环境变量可覆盖：
- `ENV_ID` — 目标云开发 env（默认项目 hardcode 的）
- `PROJECT_PATH` — 项目根路径（默认当前目录）
- `INSTALL_PATH` — cloudbase CLI 完整路径（默认 `command -v cloudbase`）

## 配置云开发环境

`miniprogram/app.js` 中调用：
```js
wx.cloud.init({
  env: "seclog-d1g8no5pc45e643aa",   // ← 你的云开发 env ID
  traceUser: true,
});
```

要切到自己的环境，改这一行即可。

## 已知状态

| 项 | 状态 |
|---|---|
| `.git/info/exclude` 含 `miniprogram/` | ⚠️ 本地 ignore——`git ls-files` 看不到小程序代码。克隆仓库的人在 push 端拿不到代码 |
| `cloudfunctions/` 当前空 | ⚠️ shell 脚本会自检退出 |
| 基础库版本 | 仓库默认 `3.8.1`；本地推荐 `3.16.2` |

## 文档参考

- [腾讯云开发文档](https://docs.cloudbase.net/)
- [微信小程序文档](https://developers.weixin.qq.com/miniprogram/dev/framework/)
- [Agent UI 组件](https://docs.cloudbase.net/ai/agent-ui)

---

**最后更新**: 2026-07-12 — 项目骨架补全（README + cloudfunctions/ + upload 脚本修复）
