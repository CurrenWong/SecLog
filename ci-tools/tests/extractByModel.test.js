// 统一意图路由测试（mock callModel，不依赖真实 CloudBase）
// classifyIntent 返回 { action: 'record'|'query'|'undo'|'chat'|'correct', ... }
const cloud = require('wx-server-sdk')
const { parseExpense, parseQuery, parseUndo } = require('../../miniprogram/utils/parseExpense')
const { classifyIntent, extractJson, validateRecord, normalizeAmount, buildPrompt } = require('../../miniprogram/utils/extractByModel')

const FUNC = require('../../cloudfunctions/miaojiRecord/index.js')

beforeEach(() => {
  cloud.__reset([], { OPENID: undefined })
})
async function call(action, payload, ctx) {
  cloud.__setCtx(ctx)
  return FUNC.main({ action, payload }, {})
}

// 模拟 chatBot 的完整意图路由：正则抽线索 → 模型判意图 → 按 action 执行
async function route(text, callModel, ctx, opts = {}) {
  const regexExpense = parseExpense(text)
  const queryHint = parseQuery(text)
  const undoHint = !!parseUndo(text)
  const recentRecord = opts.recentRecord || null
  const decision = await classifyIntent(text, callModel, { regexExpense, queryHint, undoHint, recentRecord })
  if (!decision) return { dropped: true }
  if (decision.action === 'record') {
    const r = await call('add', decision, ctx)
    return r.success ? decision : { failed: true }
  }
  if (decision.action === 'query') {
    const payload = decision.query.type === 'category' ? { category: decision.query.category } : {}
    const r = await call('stats', payload, ctx)
    return r.success ? decision : { failed: true }
  }
  if (decision.action === 'undo') return decision
  if (decision.action === 'chat') return decision
  if (decision.action === 'correct') return decision
  return decision
}

function fakeCallModel(returnText) {
  return async () => returnText
}

describe('classifyIntent 统一意图路由', () => {
  test('record: 模型返回裸 JSON → 正确解析', async () => {
    const callModel = fakeCallModel('{"action":"record","amount":-55,"category":"餐饮","note":"和同事吃火锅"}')
    const r = await classifyIntent('中午跟同事吃了顿火锅大概五十多块', callModel)
    expect(r).toEqual({ action: 'record', amount: -55, category: '餐饮', note: '和同事吃火锅' })
  })

  test('record: 模型返回 ```json 代码块 → 兼容提取', async () => {
    const callModel = fakeCallModel('好的：\n```json\n{"action":"record","amount":-12.5,"category":"交通","note":"公交"}\n```')
    const r = await classifyIntent('坐公交花了十二块五', callModel)
    expect(r.action).toBe('record')
    expect(r.amount).toBe(-12.5)
    expect(r.category).toBe('交通')
  })

  test('record: 收入正数', async () => {
    const callModel = fakeCallModel('{"action":"record","amount":800,"category":"收入","note":"工资"}')
    const r = await classifyIntent('发工资了八百块', callModel)
    expect(r).toEqual({ action: 'record', amount: 800, category: '收入', note: '工资' })
  })

  test('query: 本月汇总', async () => {
    const callModel = fakeCallModel('{"action":"query","query":{"type":"month"}}')
    const r = await classifyIntent('这个月花了多少钱', callModel)
    expect(r).toEqual({ action: 'query', query: { type: 'month' } })
  })

  test('query: 分类查询', async () => {
    const callModel = fakeCallModel('{"action":"query","query":{"type":"category","category":"餐饮"}}')
    const r = await classifyIntent('餐饮花了多少', callModel)
    expect(r).toEqual({ action: 'query', query: { type: 'category', category: '餐饮' } })
  })

  test('query: 按分类统计（breakdown，不带 category）', async () => {
    const callModel = fakeCallModel('{"action":"query","query":{"type":"breakdown"}}')
    const r = await classifyIntent('按分类统计支出', callModel)
    expect(r).toEqual({ action: 'query', query: { type: 'breakdown' } })
  })

  test('query: 各类花了多少 → breakdown', async () => {
    const callModel = fakeCallModel('{"action":"query","query":{"type":"breakdown"}}')
    const r = await classifyIntent('各类花了多少', callModel)
    expect(r.query.type).toBe('breakdown')
  })

  test('query: 收入有多少 → income（不是 category:收入）', async () => {
    const callModel = fakeCallModel('{"action":"query","query":{"type":"income"}}')
    const r = await classifyIntent('收入有多少', callModel)
    expect(r).toEqual({ action: 'query', query: { type: 'income' } })
  })

  test('query: 赚了多少 → income', async () => {
    const callModel = fakeCallModel('{"action":"query","query":{"type":"income"}}')
    const r = await classifyIntent('这个月赚了多少', callModel)
    expect(r.query.type).toBe('income')
  })

  test('query: 未知 type 兜底为 month', async () => {
    const callModel = fakeCallModel('{"action":"query","query":{"type":"xxx"}}')
    const r = await classifyIntent('花了多少', callModel)
    expect(r.query.type).toBe('month')
  })

  test('undo: 撤回', async () => {
    const callModel = fakeCallModel('{"action":"undo"}')
    const r = await classifyIntent('记错了', callModel)
    expect(r).toEqual({ action: 'undo' })
  })

  test('chat: 闲聊', async () => {
    const callModel = fakeCallModel('{"action":"chat"}')
    const r = await classifyIntent('今天天气不错', callModel)
    expect(r).toEqual({ action: 'chat' })
  })

  test('correct: 更正最近一笔', async () => {
    const recent = { _id: 'r1', amount: -50, category: '餐饮', note: '火锅' }
    const callModel = fakeCallModel('{"action":"correct","target":"last","amount":-60,"category":"餐饮","note":"火锅"}')
    const r = await classifyIntent('想起来错了，是60', callModel, { recentRecord: recent })
    expect(r).toEqual({ action: 'correct', target: 'last', amount: -60, category: '餐饮', note: '火锅' })
  })

  test('金额无效 → 退化 chat（不记）', async () => {
    const callModel = fakeCallModel('{"action":"record","amount":"好多","category":"餐饮"}')
    const r = await classifyIntent('吃了顿饭', callModel)
    expect(r.action).toBe('chat')
  })

  test('模型返回非 JSON 垃圾 → null（降级）', async () => {
    const callModel = fakeCallModel('我是模型，我不知道你在说什么')
    const r = await classifyIntent('午饭', callModel)
    expect(r).toBeNull()
  })

  test('模型调用抛错 → null（降级）', async () => {
    const callModel = async () => { throw new Error('network') }
    const r = await classifyIntent('午饭', callModel)
    expect(r).toBeNull()
  })

  test('未传 callModel → 直接 null', async () => {
    const r = await classifyIntent('午饭', null)
    expect(r).toBeNull()
  })

  test('兼容旧格式（无 action 带 amount）→ 视为 record', async () => {
    const callModel = fakeCallModel('{"amount":-38,"category":"餐饮","note":"午饭"}')
    const r = await classifyIntent('午饭38', callModel)
    expect(r.action).toBe('record')
    expect(r.amount).toBe(-38)
  })

  test('buildPrompt 包含正则线索与最近一笔上下文', async () => {
    const callModel = fakeCallModel('{"action":"chat"}')
    const p = buildPrompt('午饭38', { regexExpense: { amount: -38, category: '餐饮', note: '午饭' }, queryHint: null, undoHint: false, recentRecord: { _id: 'x', amount: -50, category: '餐饮' } })
    expect(p).toContain('午饭38')
    expect(p).toContain('正则消费抽取线索')
    expect(p).toContain('最近一笔记账')
  })
})

describe('extractJson / validateRecord / normalizeAmount 纯函数', () => {
  test('extractJson 从 markdown 代码块提取', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  test('extractJson 裸 JSON', () => {
    expect(extractJson('回复：{"a":2} 完毕')).toEqual({ a: 2 })
  })
  test('validateRecord 拒绝非数字', () => {
    expect(validateRecord({ amount: 'abc' })).toBeNull()
  })
  test('normalizeAmount 支出负数', () => {
    expect(normalizeAmount(50, 'expense')).toBe(-50)
  })
  test('normalizeAmount 0 → null', () => {
    expect(normalizeAmount(0)).toBeNull()
  })
})

describe('端到端路由（正则线索 + 模型判意图）', () => {
  const ctx = { OPENID: 'u1' }

  test('标准说法"午饭花了38块" → 模型判 record → 真实 add 落库', async () => {
    const callModel = fakeCallModel('{"action":"record","amount":-38,"category":"餐饮","note":"午饭"}')
    const r = await route('午饭花了38块', callModel, ctx)
    expect(r.action).toBe('record')
  })

  test('查询"这个月花了多少" → 模型判 query → stats 被调', async () => {
    const callModel = fakeCallModel('{"action":"query","query":{"type":"month"}}')
    const r = await route('这个月花了多少钱', callModel, ctx)
    expect(r.action).toBe('query')
    expect(r.query.type).toBe('month')
  })

  test('闲聊 → 模型判 chat → 不调 add/stats', async () => {
    const callModel = fakeCallModel('{"action":"chat"}')
    const r = await route('你好啊', callModel, ctx)
    expect(r.action).toBe('chat')
  })

  test('correct → stats 不调，update 生效（金额被改）', async () => {
    // 先记一笔
    await call('add', { amount: -50, category: '餐饮', note: '火锅' }, ctx)
    const recent = { _id: 'last1', amount: -50, category: '餐饮', note: '火锅' }
    const callModel = fakeCallModel('{"action":"correct","target":"last","amount":-60,"category":"餐饮","note":"火锅"}')
    const r = await route('想起来错了，是60', callModel, ctx, { recentRecord: recent })
    expect(r.action).toBe('correct')
  })
})
