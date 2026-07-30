module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['**/tests/**/*.test.js'],
  rootDir: __dirname,
  verbose: true,
  // 把云函数里的 require('wx-server-sdk') 重定向到我们的 mock
  moduleNameMapper: {
    '^wx-server-sdk$': '<rootDir>/__mocks__/wx-server-sdk.js',
    // 云函数顶部 require('@cloudbase/node-sdk') 仅为拍照记账 AI 通道；单元测试不覆盖 OCR，
    // 用极简 stub 让模块可加载（ai() 误调用会明确抛错）
    '^@cloudbase/node-sdk$': '<rootDir>/__mocks__/cloudbase-node-sdk-stub.js',
    // chatBot 页面的 usingComponents 引用 agent-ui，测试用极简 stub 替换，
    // 避免加载真实 agent-ui 子组件树（markdown/collapse/chatFile/...）
    '^.*/components/agent-ui/index$': '<rootDir>/__mocks__/agent-ui-stub.js',
  },
}
