// 大模型最终拍板测试（mock callModel，不依赖真实 CloudBase）
// 新结构：extractByModel 返回 { action: 'add'|'correct'|'none', ... } 统一意图
const cloud = require('wx-server-sdk')
const { parseExpense } = require('../../miniprogram/utils/parseExpense')
const { extractByModel, extractJson, validateRecord, normalizeAmount, buildPrompt } = require('../../miniprogram/utils/extractByModel')

// 云函数源码
const FUNC = require('../../cloudfunctions/miaojiRecord/index.js')

beforeEach(() => {
  cloud.__reset([], { OPENID: undefined })
})
async function call(action, payload, ctx) {
  cloud.__setCtx(ctx)
  return FUNC.main({ action, payload }, {})
}

// 模拟 chatBot 的混合记账：正则做线索，模型最终拍板
async function hybridRecord(text, callModel, ctx, opts = {}) {
  const regexHint = parseExpense(text)
  const decision = await extractByModel(text, callModel, { regexHint, recentRecord: opts.recentRecord || null })
  if (!decision || decision.action !== 'add') return decision
  const r = await call('add', decision, ctx)
  return r.success ? decision : null
}

function fakeCallModel(returnText) {
  return async () => returnText
}

describe('extractByModel 统一意图（新）', () => {
  test('add: 模型返回裸 JSON → 正确解析', async () => {
    const callModel = fakeCallModel('{"action":"add","amount":-55,"category":"餐饮","note":"和同事吃火锅"}')
    const r = await extractByModel('中午跟同事吃了顿火锅大概五十多块', callModel)
    expect(r).toEqual({ action: 'add', amount: -55, category: '餐饮', note: '和同事吃火锅' })
  })

  test('add: 模型返回 ```json 代码块 → 兼容提取', async () => {
    const callModel = fakeCallModel('好的：\n```json\n{"action":"add","amount":-12.5,"category":"交通","note":"公交"}\n```')
    const r = await extractByModel('坐公交花了十二块五', callModel)
    expect(r.action).toBe('add')
    expect(r.amount).toBe(-12.5)
    expect(r.category).toBe('交通')
  })

  test('correct: 用户说"想起来错了，是60" → action:correct, target:last', async () => {
    const recent = { _id: 'r1', amount: -50, category: '餐饮', note: '火锅' }
    const callModel = fakeCallModel('{"action":"correct","target":"last","amount":-60,"category":"餐饮","note":"火锅"}')
    const r = await extractByModel('想起来错了，是60', callModel, { recentRecord: recent })
    expect(r).toEqual({ action: 'correct', target: 'last', amount: -60, category: '餐饮', note: '火锅' })
  })

  test('none: 无记账意图 → action:none', async () => {
    const callModel = fakeCallModel('{"action":"none"}')
    const r = await extractByModel('今天天气真好', callModel)
    expect(r).toEqual({ action: 'none' })
  })

  test('none: 模型返回 amount:0（旧格式兼容）→ 归为 none', async () => {
    const callModel = fakeCallModel('{"amount":0}')
    const r = await extractByModel('随便聊聊', callModel)
    expect(r).toEqual({ action: 'none' })
  })

  test('金额带 type 字段 → 按 type 归一符号', async () => {
    const callModel = fakeCallModel('{"action":"add","amount":8000,"type":"income","category":"收入","note":"工资"}')
    const r = await extractByModel('这个月发了工资八千', callModel)
    expect(r.amount).toBe(8000)
    expect(r.category).toBe('收入')
  })

  test('分类不在白名单 → 回落为「其他」', async () => {
    const callModel = fakeCallModel('{"action":"add","amount":-30,"category":"宠物","note":"买猫粮"}')
    const r = await extractByModel('买了猫粮三十块', callModel)
    expect(r.category).toBe('其他')
  })

  test('金额超出合理范围 → action:none（防抽飞）', async () => {
    const callModel = fakeCallModel('{"action":"add","amount":99999999,"category":"购物","note":"乱写"}')
    const r = await extractByModel('买东西', callModel)
    expect(r.action).toBe('none')
  })

  test('模型返回非 JSON 垃圾 → null', async () => {
    const callModel = fakeCallModel('抱歉我没听懂')
    const r = await extractByModel('随便聊聊', callModel)
    expect(r).toBeNull()
  })

  test('模型调用抛错 → 降级失败返回 null（不记账）', async () => {
    const callModel = async () => { throw new Error('network') }
    const r = await extractByModel('买书五十', callModel)
    expect(r).toBeNull()
  })

  test('未传 callModel → 直接 null', async () => {
    const r = await extractByModel('买书五十')
    expect(r).toBeNull()
  })

  test('buildPrompt 包含正则线索与最近一笔上下文', () => {
    const p = buildPrompt('午饭38', { amount: -38, category: '餐饮', note: '午饭' }, { _id: 'r1', amount: -38, category: '餐饮', note: '午饭' })
    expect(p).toContain('午饭38')
    expect(p).toContain('正则初步抽取线索')
    expect(p).toContain('最近一笔记账')
    expect(p).toContain('action')
  })
})

describe('extractJson / validateRecord / normalizeAmount 纯函数', () => {
  test('extractJson 从 markdown 代码块提取', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  test('extractJson 裸 JSON', () => {
    expect(extractJson('前缀 {"b":2} 后缀')).toEqual({ b: 2 })
  })
  test('validateRecord 拒绝非数字', () => {
    expect(validateRecord({ amount: 'abc', category: '餐饮' })).toBeNull()
  })
  test('normalizeAmount 支出负数', () => {
    expect(normalizeAmount(-30)).toBe(-30)
  })
  test('normalizeAmount 0 → null', () => {
    expect(normalizeAmount(0)).toBeNull()
  })
})

describe('混合记账链路（正则线索 + 模型拍板）', () => {
  test('标准说法"午饭花了38块" → 正则给线索，模型确认 add', async () => {
    let capturedPrompt = ''
    const callModel = async (p) => { capturedPrompt = p; return '{"action":"add","amount":-38,"category":"餐饮","note":"午饭花了"}' }
    const parsed = await hybridRecord('午饭花了38块', callModel, { OPENID: 'u' })
    expect(parsed).toEqual({ action: 'add', amount: -38, category: '餐饮', note: '午饭花了' })
    // 正则线索应出现在 prompt 里
    expect(capturedPrompt).toContain('正则初步抽取线索')
    const list = await call('list', { limit: 5 }, { OPENID: 'u' })
    expect(list.list.length).toBe(1)
  })

  test('模糊口语 → 正则 null，模型 add 记账', async () => {
    const callModel = fakeCallModel('{"action":"add","amount":-55,"category":"餐饮","note":"和同事吃火锅"}')
    const parsed = await hybridRecord('中午跟同事吃了顿火锅大概五十多', callModel, { OPENID: 'u' })
    expect(parsed.action).toBe('add')
    expect(parsed.amount).toBe(-55)
    const list = await call('list', { limit: 5 }, { OPENID: 'u' })
    expect(list.list.length).toBe(1)
  })

  test('闲聊 → 模型返回 none → 不记账', async () => {
    const callModel = fakeCallModel('{"action":"none"}')
    const parsed = await hybridRecord('今天心情不错', callModel, { OPENID: 'u' })
    expect(parsed).toEqual({ action: 'none' })
    const list = await call('list', { limit: 5 }, { OPENID: 'u' })
    expect(list.list.length).toBe(0)
  })

  test('correct → 云函数 update 生效（金额被改）', async () => {
    // 先记一笔火锅 -50
    await call('add', { amount: -50, category: '餐饮', note: '火锅' }, { OPENID: 'u' })
    const recent = { _id: (await call('list', { limit: 1 }, { OPENID: 'u' })).list[0]._id, amount: -50, category: '餐饮', note: '火锅' }
    const callModel = fakeCallModel('{"action":"correct","target":"last","amount":-60,"category":"餐饮","note":"火锅"}')
    const decision = await extractByModel('想起来错了，是60', callModel, { recentRecord: recent })
    expect(decision.action).toBe('correct')
    // 模拟 chatBot.tryCorrect：用 recent._id 调 update
    const upd = await call('update', { _id: recent._id, amount: -60, category: '餐饮', note: '火锅' }, { OPENID: 'u' })
    expect(upd.success).toBe(true)
    const list = await call('list', { limit: 5 }, { OPENID: 'u' })
    expect(list.list.length).toBe(1) // 仍是 1 笔，未被新增
    expect(list.list[0].amount).toBe(-60) // 金额已改
  })
})
