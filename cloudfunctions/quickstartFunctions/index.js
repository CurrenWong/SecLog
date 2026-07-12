// 云函数入口文件
// 官方 quickstart 模板简化版：回显入参 + 返回运行环境信息
const cloud = require('wx-server-sdk')

cloud.init({
  env: 'seclog-d1g8no5pc45e643aa',
})

exports.main = async (event, context) => {
  // event 为小程序端 wx.cloud.callFunction({ data }) 传入的参数
  return {
    success: true,
    message: 'hello from quickstartFunctions',
    env: cloud.DYNAMIC_CURRENT_ENV,
    echo: event,
    requestId: context && context.requestId,
    timestamp: Date.now(),
  }
}
