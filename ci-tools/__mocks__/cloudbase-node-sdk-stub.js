// __mocks__/cloudbase-node-sdk-stub.js
// 单元测试用 stub：云函数顶部 require('@cloudbase/node-sdk') 支持两套路径：
//
// 1. miaojiRecord OCR 拍照记账 — 原 stub 只抛错（测试不覆盖 OCR/AI）
// 2. travelRecord NLP 自然语言解析 — 需可配置的 mock AI 响应
//
// 测试通过 __setMockResponse(text) 控制 AI 返回内容，或 __setMockError(err) 模拟失败。

let mockResponse = ''
let mockError = null

function makeModel() {
  return {
    async generateText({ model, messages }) {
      if (mockError) throw mockError
      if (mockResponse) return { text: mockResponse }
      // 默认返回一个简单的 JSON 响应
      const userMsg = messages && messages[0] && messages[0].content || ''
      const dateMatch = userMsg.match(/(\d{4}-\d{2}-\d{2})/)
      const defaultDate = dateMatch ? dateMatch[1] : '2026-08-04'
      return {
        text: JSON.stringify({
          date: defaultDate,
          time: '14:00',
          title: '测试标题',
          location: { name: '测试地点' },
          content: '测试内容',
          expense: 0,
          confidence: 0.95,
          unparsed: '',
        }),
      }
    },
  }
}

function tcbInit() {
  return {
    ai() {
      return {
        createModel(groupName) {
          if (groupName === 'cloudbase' || groupName === 'hunyuan-exp') {
            return makeModel()
          }
          throw new Error(`[stub] 未知的模型组: ${groupName}`)
        },
      }
    },
  }
}

module.exports = {
  init: tcbInit,
  app: tcbInit,
  // 测试辅助：设置 AI 返回的文本内容
  __setMockResponse(text) {
    mockResponse = text
    mockError = null
  },
  // 测试辅助：设置 AI 调用错误
  __setMockError(err) {
    mockError = err
    mockResponse = ''
  },
  // 测试辅助：重置为默认行为
  __resetMock() {
    mockResponse = ''
    mockError = null
  },
}