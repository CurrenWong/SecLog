// 大模型降级抽取测试（mock callModel，不依赖真实 CloudBase）
const cloud = require('wx-server-sdk')
const { parseExpense } = require('../../miniprogram/utils/parseExpense')
const { extractByModel, extractJson, validate, buildPrompt } = require('../../miniprogram/utils/extractByModel')

// 云函数源码
const FUNC = require('../../cloudfunctions/miaojiRecord/index.js')

beforeEach(() => {
  cloud.__reset([], { OPENID: undefined })
})
async function call(action, payload, ctx) {
  cloud.__setCtx(ctx)
  return FUNC.main({ action, payload }, {})
}

// 模拟 chatBot 的混合记账：正则优先，模型兜底
async function hybridRecord(text, callModel, ctx) {
  let parsed = parseExpense(text)
  if (!parsed && callModel) parsed = await extractByModel(text, callModel)
  if (!parsed) return null
  const r = await call('add', parsed, ctx)
  return r.success ? parsed : null
}

// 构造一个返回固定文本的 callModel
function fakeCallModel(returnText) {
  return async () => returnText
}

describe('extractByModel 大模型降级抽取', () => {
  test('模型返回裸 JSON → 正确解析', async () => {
    const callModel = fakeCallModel('{"amount":-55,"category":"餐饮","note":"和同事吃火锅"}')
    const r = await extractByModel('中午跟同事吃了顿火锅大概五十多块', callModel)
    expect(r).toEqual({ amount: -55, category: '餐饮', note: '和同事吃火锅' })
  })

  test('模型返回 ```json 代码块 → 兼容提取', async () => {
    const callModel = fakeCallModel('好的，已记录：\n```json\n{"amount":-12.5,"category":"交通","note":"公交"}\n```')
    const r = await extractByModel('坐公交花了十二块五', callModel)
    expect(r.amount).toBe(-12.5)
    expect(r.category).toBe('交通')
  })

  test('金额带 type 字段 → 按 type 归一符号', async () => {
    const callModel = fakeCallModel('{"amount":8000,"type":"income","category":"收入","note":"工资"}')
    const r = await extractByModel('这个月发了工资八千', callModel)
    expect(r.amount).toBe(8000) // 正数=收入
    expect(r.category).toBe('收入')
  })

  test('分类不在白名单 → 回落为「其他」', async () => {
    const callModel = fakeCallModel('{"amount":-30,"category":"宠物","note":"买猫粮"}')
    const r = await extractByModel('买了猫粮三十块', callModel)
    expect(r.category).toBe('其他')
  })

  test('金额超出合理范围 → 返回 null（防抽飞）', async () => {
    const callModel = fakeCallModel('{"amount":99999999,"category":"购物","note":"乱写"}')
    const r = await extractByModel('买东西', callModel)
    expect(r).toBeNull()
  })

  test('无记账意图（模型返回 amount:0）→ null，不误记', async () => {
    const callModel = fakeCallModel('{"amount":0}')
    const r = await extractByModel('今天天气真好', callModel)
    expect(r).toBeNull()
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
})

describe('extractJson / validate 纯函数', () => {
  test('extractJson 从 markdown 代码块提取', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  test('extractJson 裸 JSON', () => {
    expect(extractJson('前缀 {"b":2} 后缀')).toEqual({ b: 2 })
  })
  test('validate 拒绝非数字', () => {
    expect(validate({ amount: 'abc', category: '餐饮' })).toBeNull()
  })
  test('buildPrompt 包含用户输入与字段说明', () => {
    const p = buildPrompt('午饭38')
    expect(p).toContain('午饭38')
    expect(p).toContain('amount')
    expect(p).toContain('category')
  })
})

describe('混合记账链路（正则优先 + 模型兜底）', () => {
  test('标准说法"午饭花了38块" → 正则命中，不调模型直接记账', async () => {
    let modelCalled = false
    const callModel = async () => { modelCalled = true; return '{"amount":-999}' }
    const parsed = await hybridRecord('午饭花了38块', callModel, { OPENID: 'u' })
    expect(parsed).toEqual({ amount: -38, category: '餐饮', note: '午饭花了' })
    expect(modelCalled).toBe(false) // 正则命中就不调模型（省成本/延迟）
    const list = await call('list', { limit: 5 }, { OPENID: 'u' })
    expect(list.list.length).toBe(1)
  })

  test('模糊口语"中午跟同事吃了顿火锅大概五十多" → 正则 null，降级模型记账', async () => {
    const callModel = fakeCallModel('{"amount":-55,"category":"餐饮","note":"和同事吃火锅"}')
    const parsed = await hybridRecord('中午跟同事吃了顿火锅大概五十多', callModel, { OPENID: 'u' })
    expect(parsed).toEqual({ amount: -55, category: '餐饮', note: '和同事吃火锅' })
    const list = await call('list', { limit: 5 }, { OPENID: 'u' })
    expect(list.list.length).toBe(1)
    expect(list.list[0].amount).toBe(-55)
  })

  test('两层都抽不到（纯闲聊）→ 不记账', async () => {
    const callModel = fakeCallModel('{"amount":0}')
    const parsed = await hybridRecord('今天心情不错', callModel, { OPENID: 'u' })
    expect(parsed).toBeNull()
    const list = await call('list', { limit: 5 }, { OPENID: 'u' })
    expect(list.list.length).toBe(0)
  })

  test('正则 null 但模型返回垃圾 → 不记账（校验拦截）', async () => {
    const callModel = fakeCallModel('抱歉没听懂')
    const parsed = await hybridRecord('买东西', callModel, { OPENID: 'u' })
    expect(parsed).toBeNull()
    const list = await call('list', { limit: 5 }, { OPENID: 'u' })
    expect(list.list.length).toBe(0)
  })
})
