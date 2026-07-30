// __mocks__/cloudbase-node-sdk-stub.js
// 单元测试用极简 stub：云函数 miaojiRecord 顶部 require('@cloudbase/node-sdk') 只为
// tcb.init().ai() 的多模态通道（拍照记账 OCR）。单元测试不覆盖 OCR/AI 路径，
// 故这里只提供能让模块加载通过的最小实现，ai() 调用时抛清晰错误（而非默默成功）。
function tcbInit() {
  return {
    ai() {
      // 测试不调用 OCR，若误调用则明确失败
      throw new Error('[stub] @cloudbase/node-sdk ai() 不该在单元测试中被调用')
    },
  }
}

module.exports = {
  init: tcbInit,
  // 兼容可能的其他导出
  app: tcbInit,
}
