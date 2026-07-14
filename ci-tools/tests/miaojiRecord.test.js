// T1: miaojiRecord 云函数单元测试（mock wx-server-sdk，不依赖真实 CloudBase）
const cloud = require('wx-server-sdk')
const { parseExpense } = require('../../miniprogram/utils/parseExpense')

// 云函数源码直接 require（它内部 require('wx-server-sdk') 已被 moduleNameMapper 重定向到 mock）
const FUNC = require('../../cloudfunctions/miaojiRecord/index.js')

// 每个用例前清空内存数据库
beforeEach(() => {
  cloud.__reset([], { OPENID: undefined })
})

// 调用云函数（只切换 OPENID 上下文，不清空 store，便于同用例内累积数据）
async function call(action, payload, ctx) {
  cloud.__setCtx(ctx)
  return FUNC.main({ action, payload }, {})
}

describe('miaojiRecord 云函数', () => {
  describe('add', () => {
    test('正常新增支出（负金额自动标记 expense）', async () => {
      const r = await call('add', { amount: -38, category: '餐饮', note: '午饭' }, { OPENID: 'user1' })
      expect(r.success).toBe(true)
      expect(r.record.amount).toBe(-38)
      expect(r.record.type).toBe('expense')
      expect(r.record.category).toBe('餐饮')
      expect(r.record.openid).toBe('user1')
    })

    test('正数金额自动标记 income', async () => {
      const r = await call('add', { amount: 8000, category: '收入', note: '工资' }, { OPENID: 'user1' })
      expect(r.record.type).toBe('income')
      expect(r.record.amount).toBe(8000)
    })

    test('缺省分类回退为「其他」', async () => {
      const r = await call('add', { amount: -10 }, { OPENID: 'user1' })
      expect(r.record.category).toBe('其他')
    })

    test('amount 非数字返回 INVALID_AMOUNT', async () => {
      const r = await call('add', { amount: 'abc' }, { OPENID: 'user1' })
      expect(r.success).toBe(false)
      expect(r.code).toBe('INVALID_AMOUNT')
    })

    test('无 OPENID 时回退 anonymous 且能写入', async () => {
      const r = await call('add', { amount: -5 }, { OPENID: undefined })
      expect(r.success).toBe(true)
      expect(r.record.openid).toBe('anonymous')
    })
  })

  describe('list', () => {
    test('返回最近 N 笔，按时间倒序', async () => {
      await call('add', { amount: -10, note: 'a' }, { OPENID: 'u' })
      await call('add', { amount: -20, note: 'b' }, { OPENID: 'u' })
      await call('add', { amount: -30, note: 'c' }, { OPENID: 'u' })
      const r = await call('list', { limit: 2 }, { OPENID: 'u' })
      expect(r.success).toBe(true)
      expect(r.list.length).toBe(2)
      // 倒序：最后写入的 c 在最前
      expect(r.list[0].note).toBe('c')
    })

    test('limit 超过 50 被截断', async () => {
      for (let i = 0; i < 60; i++) await call('add', { amount: -1, note: 'x' + i }, { OPENID: 'u' })
      const r = await call('list', { limit: 999 }, { OPENID: 'u' })
      expect(r.list.length).toBe(50)
    })

    test('owner 隔离：只返回自己的记录', async () => {
      await call('add', { amount: -1, note: 'mine' }, { OPENID: 'uA' })
      await call('add', { amount: -2, note: 'others' }, { OPENID: 'uB' })
      const r = await call('list', { limit: 10 }, { OPENID: 'uA' })
      expect(r.list.length).toBe(1)
      expect(r.list[0].note).toBe('mine')
    })
  })

  describe('delete', () => {
    test('删除指定 _id', async () => {
      const added = await call('add', { amount: -15, note: 'del' }, { OPENID: 'u' })
      const r = await call('delete', { _id: added._id }, { OPENID: 'u' })
      expect(r.success).toBe(true)
      expect(r.removed).toBe(1)
    })

    test('缺 _id 返回 MISSING_ID', async () => {
      const r = await call('delete', {}, { OPENID: 'u' })
      expect(r.success).toBe(false)
      expect(r.code).toBe('MISSING_ID')
    })
  })

  describe('summary', () => {
    test('今日 / 本月 income-expense 汇总', async () => {
      // 今天的两笔
      await call('add', { amount: -38, category: '餐饮', note: '午饭' }, { OPENID: 'u' }) // 支出
      await call('add', { amount: 8000, category: '收入', note: '工资' }, { OPENID: 'u' }) // 收入
      const r = await call('summary', {}, { OPENID: 'u' })
      expect(r.success).toBe(true)
      // 云函数返回带符号金额（前端用 Math.abs 显示），expense 为负、income 为正
      expect(r.day.expense).toBe(-38)
      expect(r.day.income).toBe(8000)
      expect(r.month.expense).toBe(-38)
      expect(r.month.income).toBe(8000)
    })

    test('未知 action 返回 UNKNOWN_ACTION', async () => {
      const r = await call('foobar', {}, { OPENID: 'u' })
      expect(r.success).toBe(false)
      expect(r.code).toBe('UNKNOWN_ACTION')
    })
  })
})

// T2 + T3: parseExpense 解析 + 端到端记账链路
describe('parseExpense 文本解析（T2）', () => {
  test('支出：午饭花了38块 → -38 / 餐饮', () => {
    expect(parseExpense('午饭花了38块')).toEqual({ amount: -38, category: '餐饮', note: '午饭花了' })
  })
  test('支出：打车45 → -45 / 交通', () => {
    expect(parseExpense('打车45')).toEqual({ amount: -45, category: '交通', note: '打车' })
  })
  test('支出：买衣服200元 → -200 / 购物', () => {
    expect(parseExpense('买衣服200元')).toEqual({ amount: -200, category: '购物', note: '买衣服' })
  })
  test('收入：收到工资8000 → +8000 / 收入', () => {
    expect(parseExpense('收到工资8000')).toEqual({ amount: 8000, category: '收入', note: '收到工资' })
  })
  test('无金额的闲聊 → null', () => {
    expect(parseExpense('今天天气不错')).toBeNull()
  })
  test('纯数字无消费意图 → null（避免误记）', () => {
    expect(parseExpense('我的幸运数字是7')).toBeNull()
  })
})

// B1: 误记防护评测集（收紧意图识别 + 金额必须带单位/动作前缀）
// 目标：非消费场景的数字（排名/温度/尺寸/股价/砖块…）一律不记
describe('B1 误记防护（非消费数字不记）', () => {
  // —— 应记（正常消费/收入，带动作词或单位）——
  test('正常：奖金500元 → +500 收入', () => {
    expect(parseExpense('奖金500元')).toEqual({ amount: 500, category: '收入', note: '奖金' })
  })
  test('正常：午饭38块 → -38 餐饮', () => {
    expect(parseExpense('午饭38块')).toEqual({ amount: -38, category: '餐饮', note: '午饭' })
  })
  test('正常：花了120元买菜 → -120 其他', () => {
    const r = parseExpense('花了120元买菜')
    expect(r.amount).toBe(-120)
    expect(r.note).toContain('买菜')
  })

  // —— 不记（漏洞修复：单位词不再单独构成意图，裸数字不抽）——
  test('防护：墙高3块砖 → null（"块"非消费意图）', () => {
    expect(parseExpense('这堵墙高3块砖')).toBeNull()
  })
  test('防护：股价跌了5块 → null（无消费动作词）', () => {
    expect(parseExpense('股价跌了5块')).toBeNull()
  })
  test('防护：第3名奖金 → null（"3名"不是金额，裸数字不抽）', () => {
    expect(parseExpense('比赛得了第3名奖金')).toBeNull()
  })
  test('防护：房间38度好热 → null（温度非金额）', () => {
    expect(parseExpense('房间38度好热')).toBeNull()
  })
  test('防护：离终点还有2公里 → null', () => {
    expect(parseExpense('离终点还有2公里')).toBeNull()
  })
  test('防护：我身高180 → null（裸数字无单位/动作）', () => {
    expect(parseExpense('我身高180')).toBeNull()
  })
  test('防护：第38名 → null', () => {
    expect(parseExpense('我排第38名')).toBeNull()
  })
  test('防护：奖金500（无单位）→ null（保守：漏记优先于误记，用户可补"元"）', () => {
    // 行为说明：去掉裸数字第三式后，"奖金500"无单位词不抽金额→null。
    // 这是有意保守设计：误记比漏记更糟，用户说"奖金500元"即可正常记。
    expect(parseExpense('奖金500')).toBeNull()
  })

  // —— B1 回归补充：餐饮类目词无单位也应记（修复"午饭38"不记）——
  test('正常：午饭38（无单位）→ -38 餐饮（类目词即消费意图）', () => {
    expect(parseExpense('午饭38')).toEqual({ amount: -38, category: '餐饮', note: '午饭' })
  })
  test('正常：早餐25 → -25 餐饮', () => {
    expect(parseExpense('早餐25')).toEqual({ amount: -25, category: '餐饮', note: '早餐' })
  })
  test('正常：晚饭60块 → -60 餐饮（类目词+单位）', () => {
    expect(parseExpense('晚饭60块')).toEqual({ amount: -60, category: '餐饮', note: '晚饭' })
  })
  test('回归：仍不破坏 B1 防护（第3名奖金/墙高3块砖 仍 null）', () => {
    expect(parseExpense('第3名奖金')).toBeNull()
    expect(parseExpense('这堵墙高3块砖')).toBeNull()
  })
})

describe('记账端到端链路（T3）', () => {
  test('"午饭花了38块" → 解析 → add 成功落库', async () => {
    const parsed = parseExpense('午饭花了38块')
    const r = await call('add', parsed, { OPENID: 'e2eUser' })
    expect(r.success).toBe(true)
    expect(r.record.amount).toBe(-38)
    expect(r.record.category).toBe('餐饮')

    // 验证确实入库
    const list = await call('list', { limit: 5 }, { OPENID: 'e2eUser' })
    expect(list.list.length).toBe(1)
    expect(list.list[0].amount).toBe(-38)
  })

  test('"收到工资8000" → 解析 → add 成功（income）', async () => {
    const parsed = parseExpense('收到工资8000')
    const r = await call('add', parsed, { OPENID: 'e2eUser' })
    expect(r.success).toBe(true)
    expect(r.record.type).toBe('income')
  })

  test('非记账闲聊 → 不触发记账', async () => {
    const parsed = parseExpense('今天天气不错')
    expect(parsed).toBeNull()
    // 库里不应新增
    const list = await call('list', { limit: 5 }, { OPENID: 'e2eUser' })
    expect(list.list.length).toBe(0)
  })
})
