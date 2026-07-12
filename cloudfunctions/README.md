# cloudfunctions/

> ⚠️ **空目录，存根说明**。项目根 `project.config.json` 里有 `cloudfunctionRoot: "cloudfunctions/"` 声明，开发者工具会扫描这里放云函数代码。当前还没真实函数，待加。

## 目录约定

```
cloudfunctions/
├── quickstartFunctions/    ← 标准模板（待加）
│   ├── index.js
│   ├── package.json
│   └── config.json
└── README.md (本文件)
```

每个函数一个子目录，名字 = `project.config.json` 里 `--n` 那个参数。

## 部署

```bash
# 方式一：用项目自带脚本（已修复）
./uploadCloudFunction.sh

# 方式二：直接 tcb cli
${installPath} cloud functions deploy --e <envId> --n quickstartFunctions --r --project .
```

`installPath` 通常是：
- npm 全局安装：`$(npm root -g)/@cloudbase/cli/bin/cloudbase.js`
- macOS/Linux 也可能：`/usr/local/bin/cloudbase`

## 与项目代码的关系

- `miniprogram/app.js` 里调用 `wx.cloud.init({ env: "<envId>" })`
- 小程序侧 `wx.cloud.callFunction({ name: "quickstartFunctions" })` 触发此处的函数
- 当前 `seclog-d1g8no5pc45e643aa` env 已通过 cloudbase MCP 测试可达
