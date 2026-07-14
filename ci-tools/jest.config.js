module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['**/tests/**/*.test.js'],
  rootDir: __dirname,
  verbose: true,
  // 把云函数里的 require('wx-server-sdk') 重定向到我们的 mock
  moduleNameMapper: {
    '^wx-server-sdk$': '<rootDir>/__mocks__/wx-server-sdk.js',
  },
}
