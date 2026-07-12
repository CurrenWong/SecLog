#!/usr/bin/env bash
# uploadCloudFunction.sh — 部署 quickstartFunctions 到云开发
#
# 使用方法：
#   1. 首次：npm i -g @cloudbase/cli  （拿到 tcb cli）
#   2. 编辑下面 3 个变量（INSTALL_PATH / ENV_ID / PROJECT_PATH）
#   3. bash uploadCloudFunction.sh
#
# 本脚本是项目自带的便捷 wrapper，背后命令是 tcb cli 的官方 deploy。

set -euo pipefail

# ====== 必填：3 个变量 ======

# tcb cli 路径。常见值：
#   npm 全局: $(npm root -g)/@cloudbase/cli/bin/cloudbase.js
#   npx:      让 npx 自己找（推荐）
#   Homebrew: /usr/local/bin/cloudbase
INSTALL_PATH="$(command -v cloudbase || echo '')"

# 目标云开发环境 ID（在腾讯云开发控制台查看）
# 默认使用项目 hardcode 的：seclog-d1g8no5pc45e643aa
ENV_ID="${ENV_ID:-seclog-d1g8no5pc45e643aa}"

# 项目根目录（含 miniprogram/ + cloudfunctions/）
# 默认当前目录
PROJECT_PATH="${PROJECT_PATH:-.}"

# ====== 自检 ======

if [[ -z "$INSTALL_PATH" ]]; then
  echo "❌ 找不到 cloudbase CLI。"
  echo "   安装：npm i -g @cloudbase/cli"
  echo "   或者设环境变量：export INSTALL_PATH=/path/to/cloudbase"
  exit 1
fi

if [[ ! -d "${PROJECT_PATH}/cloudfunctions" ]]; then
  echo "❌ cloudfunctions/ 目录不存在：${PROJECT_PATH}/cloudfunctions"
  exit 1
fi

if [[ ! -d "${PROJECT_PATH}/cloudfunctions/quickstartFunctions" ]]; then
  echo "❌ cloudfunctions/quickstartFunctions/ 目录不存在。"
  echo "   先建立：mkdir -p ${PROJECT_PATH}/cloudfunctions/quickstartFunctions"
  exit 1
fi

# ====== 部署 ======

echo "🚀 Deploying quickstartFunctions → env=${ENV_ID}"
echo "   from ${PROJECT_PATH}"

"${INSTALL_PATH}" cloud functions deploy \
  --e "${ENV_ID}" \
  --n quickstartFunctions \
  --r \
  --project "${PROJECT_PATH}"

echo "✅ Done."
