// chatBot 记账确认行为测试（mock wx / 云函数 / agent-ui）
// 验证：确认消息归一为前端插入（唯一来源）；
//   正则结果喂模型做线索，模型最终拍板（add/correct/none）；
//   确定值 model 不调（省成本），模糊值调模型带引导。
const cloud = require('wx-server-sdk')
const { parseExpense, parseUndo, parseQuery } = require('../../miniprogram/utils/parseExpense')
const { classifyIntent } = require('../../miniprogram/utils/extractByModel')

// 确认文案生成（与 chatBot.doAdd 生产逻辑保持一致）
function buildAddConfirm(parsed, source) {
  const sign = parsed.amount < 0 ? '-' : '+'
  const notePart = parsed.note ? `（${parsed.note}）` : ''
  return source === 'model'
    ? `✅ 已记：**${parsed.category}** ${sign}¥${Math.abs(parsed.amount)}${notePart}，数额不对随时跟我说改~`
    : `✅ 已记：**${parsed.category}** ${sign}¥${Math.abs(parsed.amount)}${notePart}`
}
function buildCorrectConfirm(parsed) {
  const sign = parsed.amount < 0 ? '-' : '+'
  const notePart = parsed.note ? `（${parsed.note}）` : ''
  return `✅ 已更正：**${parsed.category}** ${sign}¥${Math.abs(parsed.amount)}${notePart}`
}

const FUNC = require('../../cloudfunctions/miaojiRecord/index.js')
beforeEach(() => { cloud.__reset([], { OPENID: undefined }) })
async function call(action, payload, ctx) { cloud.__setCtx(ctx); return FUNC.main({ action, payload }, {}) }

// 模拟 chatBot.onUserSend 的决策链路（与生产同构：正则做线索 → classifyIntent 模型拍板 → 分支）
async function tryRecord(text, callModel, ctx, opts = {}) {
  const regexHint = parseExpense(text)
  const decision = await classifyIntent(text, callModel, { regexExpense: regexHint, queryHint: parseQuery(text), undoHint: !!parseUndo(text), recentRecord: opts.recentRecord || null })
  if (!decision || decision.action === 'chat') return { recorded: false, action: decision ? decision.action : null }
  if (decision.action === 'correct') {
    // 模拟 tryCorrect：查最近一笔 → update
    const listRes = await call('list', { limit: 1 }, ctx)
    const list = (listRes.success && listRes.list) || []
    if (!list.length) {
      // 无记录退化为 record（add）
      const r = await call('add', decision, ctx)
      return { recorded: true, action: 'record', confirm: buildAddConfirm(decision, regexHint ? 'regex' : 'model'), parsed: decision }
    }
    const last = list[0]
    const upd = await call('update', { _id: last._id, ...decision }, ctx)
    return { recorded: true, action: 'correct', confirm: buildCorrectConfirm(decision), parsed: decision, updated: upd.success }
  }
  if (decision.action === 'record') {
    const r = await call('add', decision, ctx)
    if (!r.success) return { recorded: false }
    return { recorded: true, action: 'record', source: regexHint ? 'regex' : 'model', confirm: buildAddConfirm(decision, regexHint ? 'regex' : 'model'), parsed: decision }
  }
  return { recorded: false, action: decision.action }
}

describe('chatBot 确认消息归一（统一意图结构）', () => {
  test('正则确定值"午饭花了38块" → 正则给线索，模型确认 add，确认不含"大概"', async () => {
    let modelCalled = false
    const callModel = async () => { modelCalled = true; return '{"action":"record","amount":-38,"category":"餐饮","note":"午饭花了"}' }
    const r = await tryRecord('午饭花了38块', callModel, { OPENID: 'u' })
    expect(r.recorded).toBe(true)
    expect(r.action).toBe('record')
    expect(r.source).toBe('regex')
    expect(r.confirm).toBe('✅ 已记：**餐饮** -¥38（午饭花了）')
    expect(r.confirm).not.toContain('大概')
    expect(r.confirm).not.toContain('对吗')
    expect(modelCalled).toBe(true) // 新架构：即使确定值也调模型拍板（线索+最终判定）
  })

  test('模型模糊值"中午火锅大概五十多" → add + 引导语', async () => {
    const callModel = async () => '{"action":"record","amount":-55,"category":"餐饮","note":"和同事吃火锅"}'
    const r = await tryRecord('中午跟同事吃了顿火锅大概五十多', callModel, { OPENID: 'u' })
    expect(r.recorded).toBe(true)
    expect(r.action).toBe('record')
    expect(r.source).toBe('model')
    expect(r.confirm).toContain('数额不对随时跟我说改')
    expect(r.confirm).not.toContain('大概的，对吗？')
  })

  test('闲聊 → chat → 不记账', async () => {
    const callModel = async () => '{"action":"chat"}'
    const r = await tryRecord('今天天气不错', callModel, { OPENID: 'u' })
    expect(r.recorded).toBe(false)
    expect(r.action).toBe('chat')
  })

  test('"想起来错了，是60" → correct → 更新最近一笔（不新增）', async () => {
    const ctx = { OPENID: 'u_correct' }
    await call('add', { amount: -50, category: '餐饮', note: '火锅' }, ctx)
    const recent = { _id: (await call('list', { limit: 1 }, ctx)).list[0]._id, amount: -50, category: '餐饮', note: '火锅' }
    const callModel = async () => '{"action":"correct","target":"last","amount":-60,"category":"餐饮","note":"火锅"}'
    const r = await tryRecord('想起来错了，是60', callModel, ctx, { recentRecord: recent })
    expect(r.recorded).toBe(true)
    expect(r.action).toBe('correct')
    expect(r.confirm).toBe('✅ 已更正：**餐饮** -¥60（火锅）')
    expect(r.updated).toBe(true)
    const list = await call('list', { limit: 10 }, ctx)
    expect(list.list.length).toBe(1) // 仍是 1 笔
    expect(list.list[0].amount).toBe(-60) // 金额已改
  })

  test('correct 但无记录 → 退化为 add（新记一笔）', async () => {
    const callModel = async () => '{"action":"correct","target":"last","amount":-60,"category":"餐饮","note":"火锅"}'
    const r = await tryRecord('想起来错了，是60', callModel, { OPENID: 'u_norecord' })
    expect(r.recorded).toBe(true)
    expect(r.action).toBe('record')
  })
})

describe('parseUndo 撤回意图识别（仅明确删除动作）', () => {
  test('明确撤回词命中', () => {
    expect(parseUndo('撤回')).toBe(true)
    expect(parseUndo('撤销刚才那笔')).toBe(true)
    expect(parseUndo('删掉')).toBe(true)
    expect(parseUndo('删除这笔')).toBe(true)
    expect(parseUndo('取消记录')).toBe(true)
  })
  test('"错了/不对"不再命中（交给模型判 correct）', () => {
    expect(parseUndo('想起来错了')).toBe(false)
    expect(parseUndo('记的不对')).toBe(false)
    expect(parseUndo('搞错了')).toBe(false)
  })
  test('非撤回意图不命中', () => {
    expect(parseUndo('午饭花了38')).toBe(false)
    expect(parseUndo('今天天气不错')).toBe(false)
  })
})

describe('撤回端到端（记一笔 → 撤回 → 列表清空）', () => {
  // 复刻 chatBot.tryUndo 的链路（与生产同构：list limit=1 → delete）
  async function tryUndo(ctx) {
    const listRes = await call('list', { limit: 1 }, ctx)
    const list = (listRes.success && listRes.list) || []
    if (!list.length) return { undone: false, reason: 'empty' }
    const last = list[0]
    const del = await call('delete', { _id: last._id }, ctx)
    return { undone: !!(del.success), last }
  }

  test('记一笔后撤回 → 列表为空', async () => {
    const ctx = { OPENID: 'u_undo' }
    const add = await call('add', { amount: -38, category: '餐饮', note: '午饭' }, ctx)
    expect(add.success).toBe(true)
    let lst = await call('list', { limit: 10 }, ctx)
    expect(lst.list.length).toBe(1)
    const r = await tryUndo(ctx)
    expect(r.undone).toBe(true)
    expect(r.last.category).toBe('餐饮')
    lst = await call('list', { limit: 10 }, ctx)
    expect(lst.list.length).toBe(0)
  })

  test('无记录时撤回 → 不报错、不删', async () => {
    const ctx = { OPENID: 'u_empty' }
    const r = await tryUndo(ctx)
    expect(r.undone).toBe(false)
    expect(r.reason).toBe('empty')
  })

  test('撤回只删自己的最新一笔（owner 隔离）', async () => {
    const a = { OPENID: 'uA' }
    const b = { OPENID: 'uB' }
    await call('add', { amount: -10, category: '餐饮', note: 'A的' }, a)
    await call('add', { amount: -20, category: '交通', note: 'B的' }, b)
    const r = await tryUndo(a)
    expect(r.undone).toBe(true)
    expect(r.last.note).toBe('A的')
    const bList = await call('list', { limit: 10 }, b)
    expect(bList.list.length).toBe(1)
    expect(bList.list[0].note).toBe('B的')
  })
})

describe('parseQuery 统计查询意图识别', () => {
  test('"这个月花了多少钱" → month', () => {
    expect(parseQuery('这个月花了多少钱')).toEqual({ type: 'month', month: 'this' })
  })
  test('"今天花了多少" → day', () => {
    expect(parseQuery('今天花了多少')).toEqual({ type: 'day' })
  })
  test('"餐饮花了多少" → category 餐饮', () => {
    expect(parseQuery('餐饮花了多少')).toEqual({ type: 'category', category: '餐饮' })
  })
  test('"最近记了啥" → recent', () => {
    expect(parseQuery('最近记了啥')).toEqual({ type: 'recent' })
  })
  test('纯记账语句不是查询（返回 null）', () => {
    expect(parseQuery('午饭花了38块')).toBeNull()
  })
  test('闲聊不是查询（无查询信号词）', () => {
    expect(parseQuery('今天天气不错')).toBeNull()
  })
  test('"火锅花了多少" → category 餐饮（命中火锅关键词）', () => {
    expect(parseQuery('火锅花了多少')).toEqual({ type: 'category', category: '餐饮' })
  })
})
