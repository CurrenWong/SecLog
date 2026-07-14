module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['**/tests/**/*.test.js'],
  rootDir: __dirname,
  verbose: true,
  // 把云函数里的 require('wx-server-sdk') 重定向到我们的 mock
  moduleNameMapper: {
    '^wx-server-sdk$': '<rootDir>/__mocks__/wx-server-sdk.js',
    // chatBot 页面的 usingComponents 引用 agent-ui，测试用极简 stub 替换，
    // 避免加载真实 agent-ui 子组件树（markdown/collapse/chatFile/...）
    '^.*/components/agent-ui/index$': '<rootDir>/__mocks__/agent-ui-stub.js',
  },
}
