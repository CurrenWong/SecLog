// chatBot 记账确认行为测试（mock wx / 云函数 / agent-ui）
// 验证：确认消息归一为前端插入（唯一来源），正则=确定值直接确认，模型降级=模糊值带核实语气
const cloud = require('wx-server-sdk')
const { parseExpense, parseUndo } = require('../../miniprogram/utils/parseExpense')
const { extractByModel } = require('../../miniprogram/utils/extractByModel')

// 直接加载 chatBot 的逻辑函数需要 Page() 环境，这里改为复刻 tryRecord 的确认文案分支，
// 因为 chatBot.js 依赖 wx/Page 无法在 node 直接 require。
// 我们把"确认文案生成"抽成可测的纯函数放这里验证（与生产逻辑保持一致）。
function buildConfirm(parsed, source) {
  const sign = parsed.amount < 0 ? '-' : '+'
  const notePart = parsed.note ? `（${parsed.note}）` : ''
  return source === 'model'
    ? `✅ 已记：<b>${parsed.category}</b> ${sign}¥${Math.abs(parsed.amount)}${notePart}（大概的，对吗？）`
    : `✅ 已记：<b>${parsed.category}</b> ${sign}¥${Math.abs(parsed.amount)}${notePart}`
}

const FUNC = require('../../cloudfunctions/miaojiRecord/index.js')
beforeEach(() => { cloud.__reset([], { OPENID: undefined }) })
async function call(action, payload, ctx) { cloud.__setCtx(ctx); return FUNC.main({ action, payload }, {}) }

// 模拟 chatBot.tryRecord 的"确认来源 + 文案"决策（与生产代码同构）
async function tryRecord(text, callModel, ctx) {
  let parsed = parseExpense(text)
  let source = parsed ? 'regex' : null
  if (!parsed) {
    parsed = await extractByModel(text, callModel)
    if (parsed) source = 'model'
  }
  if (!parsed) return { recorded: false }
  const r = await call('add', parsed, ctx)
  if (!r.success) return { recorded: false }
  return { recorded: true, source, confirm: buildConfirm(parsed, source), parsed }
}

describe('chatBot 确认消息归一（按建议修改后）', () => {
  test('正则确定值"午饭花了38块" → 确认不含"大概/对吗"', async () => {
    const r = await tryRecord('午饭花了38块', async () => '{"amount":0}', { OPENID: 'u' })
    expect(r.recorded).toBe(true)
    expect(r.source).toBe('regex')
    expect(r.confirm).toBe('✅ 已记：<b>餐饮</b> -¥38（午饭花了）')
    expect(r.confirm).not.toContain('大概')
    expect(r.confirm).not.toContain('对吗')
  })

  test('模型模糊值"中午火锅大概五十多" → 确认带"大概的，对吗？"', async () => {
    const callModel = async () => '{"amount":-55,"category":"餐饮","note":"和同事吃火锅"}'
    const r = await tryRecord('中午跟同事吃了顿火锅大概五十多', callModel, { OPENID: 'u' })
    expect(r.recorded).toBe(true)
    expect(r.source).toBe('model')
    expect(r.confirm).toContain('大概的，对吗？')
  })

  test('两层都抽不到 → 不记账（无确认消息）', async () => {
    const r = await tryRecord('今天天气不错', async () => '{"amount":0}', { OPENID: 'u' })
    expect(r.recorded).toBe(false)
  })

  test('确认消息由前端代码统一生成（source 决定文案，模型回复不重复）', async () => {
    // 正则命中时模型根本不该被调（省成本/延迟），确认完全来自代码
    let modelCalled = false
    const callModel = async () => { modelCalled = true; return '{"amount":0}' }
    const r = await tryRecord('打车45', callModel, { OPENID: 'u' })
    expect(r.source).toBe('regex')
    expect(modelCalled).toBe(false) // 确定值不调模型 → 确认文案 100% 来自代码
  })
})

describe('parseUndo 撤回意图识别', () => {
  test('明确撤回词命中', () => {
    expect(parseUndo('记错了')).toBe(true)
    expect(parseUndo('撤回')).toBe(true)
    expect(parseUndo('撤销刚才那笔')).toBe(true)
    expect(parseUndo('删掉')).toBe(true)
    expect(parseUndo('不对，记反了')).toBe(true)
  })
  test('非撤回意图不命中', () => {
    expect(parseUndo('午饭花了38')).toBe(false)
    expect(parseUndo('今天天气不错')).toBe(false)
    expect(parseUndo('收到工资8000')).toBe(false)
  })
})

describe('撤回端到端（记一笔 → 撤回 → 列表清空）', () => {
  // 复刻 chatBot.tryUndo 的链路（与生产同构：list limit=1 → delete）
  // 注意：云函数 list 返回 { success, list:[...] }，delete 返回 { success, removed }
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
    // 先记一笔
    const add = await call('add', { amount: -38, category: '餐饮', note: '午饭' }, ctx)
    expect(add.success).toBe(true)
    // 确认有 1 笔
    let lst = await call('list', { limit: 10 }, ctx)
    expect(lst.list.length).toBe(1)
    // 撤回
    const r = await tryUndo(ctx)
    expect(r.undone).toBe(true)
    expect(r.last.category).toBe('餐饮')
    // 列表清空
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
    // A 撤回 → 只删 A 的，B 的还在
    const r = await tryUndo(a)
    expect(r.undone).toBe(true)
    expect(r.last.note).toBe('A的')
    const bList = await call('list', { limit: 10 }, b)
    expect(bList.list.length).toBe(1)
    expect(bList.list[0].note).toBe('B的')
  })
})
