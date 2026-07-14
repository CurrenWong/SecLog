// utils/cloudInstance.js
// 获取 CloudBase 实例（CommonJS 版，供 chatBot.js require 使用）。
// 逻辑与 components/agent-ui/tools.js 的 getCloudInstance 保持一致。
let cloudInstance = null

async function getCloudInstance(envShareConfig) {
  if (cloudInstance) return cloudInstance
  if (envShareConfig && envShareConfig.resourceAppid && envShareConfig.resourceEnv) {
    const instance = new wx.cloud.Cloud({
      resourceAppid: envShareConfig.resourceAppid,
      resourceEnv: envShareConfig.resourceEnv,
    })
    await instance.init()
    instance.env = envShareConfig.resourceEnv
    cloudInstance = instance
    return cloudInstance
  }
  cloudInstance = wx.cloud
  return cloudInstance
}

module.exports = { getCloudInstance }
