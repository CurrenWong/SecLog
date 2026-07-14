// collectStreamText 单元测试
// 验证各种 streamText 返回形态都能正确收集到文本
const { collectStreamText } = require('../../miniprogram/utils/collectStreamText')

// 构造一个 eventStream 异步迭代器（CloudBase AI SDK 真机形态）
function makeEventStream(chunks) {
  async function* gen() {
    for (const c of chunks) yield c
  }
  return gen()
}

// 构造一个普通异步迭代器（OpenAI 兼容 / 简单格式）
function makeAsyncIter(chunks) {
  async function* gen() {
    for (const c of chunks) yield c
  }
  return gen()
}

describe('collectStreamText', () => {
  test('情况1: res 本身是字符串', async () => {
    expect(await collectStreamText('hello')).toBe('hello')
  })

  test('情况2: res.text 是字符串', async () => {
    expect(await collectStreamText({ text: 'hi' })).toBe('hi')
  })

  test('情况3: res.text 是 Promise', async () => {
    expect(await collectStreamText({ text: Promise.resolve('prom') })).toBe('prom')
  })

  test('情况3: res.text 是函数返回字符串', async () => {
    expect(await collectStreamText({ text: () => 'fn' })).toBe('fn')
  })

  test('情况4: eventStream（真机 SSE 格式，多条 delta 拼接）', async () => {
    const stream = makeEventStream([
      { data: JSON.stringify({ choices: [{ delta: { content: '火' }, finish_reason: null }] }) },
      { data: JSON.stringify({ choices: [{ delta: { content: '锅' }, finish_reason: null }] }) },
      { data: JSON.stringify({ choices: [{ delta: { content: '5' }, finish_reason: 'stop' }] }) },
    ])
    expect(await collectStreamText({ eventStream: stream })).toBe('火锅5')
  })

  test('情况4: eventStream 含 finish_reason=stop 提前终止', async () => {
    const stream = makeEventStream([
      { data: JSON.stringify({ choices: [{ delta: { content: 'A' }, finish_reason: null }] }) },
      { data: JSON.stringify({ choices: [{ delta: { content: 'B' }, finish_reason: 'stop' }] }) },
      { data: JSON.stringify({ choices: [{ delta: { content: 'C' }, finish_reason: null }] }) },
    ])
    expect(await collectStreamText({ eventStream: stream })).toBe('AB')
  })

  test('情况4: eventStream 空 data 跳过不报错', async () => {
    const stream = makeEventStream([
      { data: 'not-json' },
      { data: JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) },
    ])
    expect(await collectStreamText({ eventStream: stream })).toBe('ok')
  })

  test('情况5: textStream yield 字符串片段', async () => {
    const stream = makeAsyncIter(['大', '概', '50'])
    expect(await collectStreamText({ textStream: stream })).toBe('大概50')
  })

  test('情况5: textStream yield { text } 对象', async () => {
    const stream = makeAsyncIter([{ text: '约' }, { text: '三十' }])
    expect(await collectStreamText({ textStream: stream })).toBe('约三十')
  })

  test('情况6: res 自身是异步迭代器（OpenAI 格式）', async () => {
    const iter = makeAsyncIter([
      { choices: [{ delta: { content: '中' } }] },
      { choices: [{ delta: { content: '午' } }] },
    ])
    expect(await collectStreamText(iter)).toBe('中午')
  })

  test('情况6: res 自身是异步迭代器（简单 delta 字符串）', async () => {
    const iter = makeAsyncIter([{ delta: '吃' }, { delta: '了' }])
    expect(await collectStreamText(iter)).toBe('吃了')
  })

  test('无法识别的结构返回空串', async () => {
    expect(await collectStreamText({})).toBe('')
    expect(await collectStreamText(null)).toBe('')
    expect(await collectStreamText(undefined)).toBe('')
  })

  test('eventStream 优先于 textStream（真机以 eventStream 为准）', async () => {
    const eventStream = makeEventStream([
      { data: JSON.stringify({ choices: [{ delta: { content: 'EVENT' }, finish_reason: 'stop' }] }) },
    ])
    const textStream = makeAsyncIter(['TEXT'])
    expect(await collectStreamText({ eventStream, textStream })).toBe('EVENT')
  })
})
