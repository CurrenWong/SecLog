// A1: chatBot 页面级集成测试（真实 chatBot.js 源码 + 页面实例语义）
//
// 说明：miniprogram-simulate 是组件测试框架，不注入 Page 全局，无法直接 load 用 Page() 的页面。
// 因此这里用「注入 global.Page 捕获页面配置 → 构造页面实例」的方式，跑真实 chatBot.js 的逻辑，
// 验证：
//   1) 对话流出现 ✅ 确认卡片（selectComponent('#agentui').appendAssistantMessage 收到正确文案）
//   2) 记账云函数被调用（wx.cloud.callFunction add）
//   3) 失败 / 撤回 / 更正 分支行为正确
//
// 新架构（2026-07-14）：模型先判意图（classifyIntent），代码按 action 路由。
//   onUserSend 统一入口 → classifyIntent（模型返回 intent JSON）→ switch(action)

// 注入前端全局 wx（测试环境无真实 wx）
const callFunctionMock = jest.fn()
const appendMock = jest.fn()
beforeAll(() => {
  global.wx = {
    cloud: { callFunction: callFunctionMock },
    showToast: jest.fn(),
  }
})

// 捕获 Page({...}) 配置
let pageOpts
beforeAll(() => {
  global.Page = (opts) => { pageOpts = opts }
  // require 会执行 Page(pageOpts)，被上面的全局捕获
  require('../../miniprogram/pages/chatBot/chatBot.js')
})

// 构造一个页面实例（微信页面配置里方法直接写在顶层，无 methods 包裹）
function makeInst() {
  const inst = Object.assign({}, pageOpts.data)
  Object.keys(pageOpts).forEach((k) => {
    if (k === 'data') return
    if (typeof pageOpts[k] === 'function') inst[k] = pageOpts[k].bind(inst)
  })
  // 注意：selectComponent 返回的对象需含 appendAssistantMessage（appendQueryMsg/appendUndoMsg 用）
  // 以及 suppressModelOnce（onUserSend 同步段调用；测试里不存在则跳过，不影响断言）
  inst.selectComponent = jest.fn().mockReturnValue({ appendAssistantMessage: appendMock })
  return inst
}

const sleep = (ms = 20) => new Promise((r) => setTimeout(r, ms))

// 默认：callFunction 正常返回（add/list/delete 都成功）
beforeEach(() => {
  callFunctionMock.mockReset()
  appendMock.mockReset()
  global.wx.showToast.mockReset()
  callFunctionMock.mockImplementation(({ name, data }) => {
    if (name === 'miaojiRecord' && data.action === 'add') return Promise.resolve({ result: { success: true } })
    if (name === 'miaojiRecord' && data.action === 'list') return Promise.resolve({ result: { success: true, list: [{ _id: 'x1', amount: -38, category: '餐饮', note: '午饭' }] } })
    if (name === 'miaojiRecord' && data.action === 'delete') return Promise.resolve({ result: { success: true, removed: 1 } })
    if (name === 'miaojiRecord' && data.action === 'update') return Promise.resolve({ result: { success: true, updated: 1 } })
    if (name === 'miaojiRecord' && data.action === 'stats') return Promise.resolve({ result: { success: true, expenseTotal: -100, incomeTotal: 0, net: -100, count: 2, byCategory: [{ category: '餐饮', amount: -100 }], records: [] } })
    return Promise.resolve({ result: { success: false } })
  })
})

// 默认模型回复：record 确认（测试可覆盖）。新架构返回 intent JSON（action: record）
function defaultModelSpy(inst, returnText = '{"action":"record","amount":-38,"category":"餐饮","note":"午饭"}') {
  return jest.spyOn(inst, 'callModelForExtract').mockResolvedValue(returnText)
}

// 走 onUserSend（与真实 agent-ui 触发一致），await 等异步路由完成
async function send(inst, text) {
  await inst.onUserSend({ detail: { content: text } })
  await sleep()
}

describe('A1 chatBot 页面集成：发消息 → 对话流出现 ✅ 卡片', () => {
  test('确定值"午饭38块" → appendAssistantMessage 收到 ✅ 确认，云函数 add 被调，模型判 record', async () => {
    const inst = makeInst()
    const modelSpy = defaultModelSpy(inst)

    await send(inst, '午饭38块')

    expect(appendMock).toHaveBeenCalledTimes(1)
    const msg = appendMock.mock.calls[0][0]
    expect(msg).toContain('✅ 已记')
    expect(msg).toContain('餐饮')
    expect(msg).toContain('-¥38')
    expect(msg).not.toContain('大概') // 确定值不带核实语气

    // 记账云函数被调用
    expect(callFunctionMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'miaojiRecord', data: expect.objectContaining({ action: 'add' }) })
    )
    // 新架构：模型判意图（record），callModelForExtract 被调
    expect(modelSpy).toHaveBeenCalled()
  })

  test('云函数 add 失败 → 不追加确认卡片，toast 失败', async () => {
    callFunctionMock.mockImplementation(({ name, data }) => {
      if (name === 'miaojiRecord' && data.action === 'add') return Promise.resolve({ result: { success: false } })
      if (name === 'miaojiRecord' && data.action === 'list') return Promise.resolve({ result: { success: true, list: [] } })
      return Promise.resolve({ result: { success: false } })
    })
    const inst = makeInst()
    defaultModelSpy(inst)
    await send(inst, '打车45')
    await sleep()

    expect(appendMock).not.toHaveBeenCalled() // 失败不插确认
    expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '记账失败' }))
  })

  test('onUserSend 撤回意图 → 模型判 undo → 走 tryUndo（list+delete，不 add）', async () => {
    const inst = makeInst()
    // 模型判 undo
    jest.spyOn(inst, 'callModelForExtract').mockResolvedValue('{"action":"undo"}')
    await send(inst, '撤回')
    await sleep()

    // 撤回确认卡片出现
    expect(appendMock).toHaveBeenCalled()
    const msg = appendMock.mock.calls[appendMock.mock.calls.length - 1][0]
    expect(msg).toContain('🗑️ 已撤回')
    // 调了 list + delete，没调 add（没记账）
    const actions = callFunctionMock.mock.calls.map((c) => c[0].data.action)
    expect(actions).toContain('list')
    expect(actions).toContain('delete')
    expect(actions).not.toContain('add')
  })

  test('onUserSend 消费意图 → 模型判 record → 走 doAdd（记账）', async () => {
    const inst = makeInst()
    defaultModelSpy(inst)
    await send(inst, '午饭38块')
    await sleep()

    const actions = callFunctionMock.mock.calls.map((c) => c[0].data.action)
    expect(actions).toContain('add')
    expect(appendMock).toHaveBeenCalled()
    expect(appendMock.mock.calls[0][0]).toContain('✅ 已记')
  })

  test('查询意图 → 模型判 query → tryQuery 走 stats（不 add，不记账）', async () => {
    const inst = makeInst()
    jest.spyOn(inst, 'callModelForExtract').mockResolvedValue('{"action":"query","query":{"type":"month"}}')
    await send(inst, '这个月花了多少钱')
    await sleep()

    const actions = callFunctionMock.mock.calls.map((c) => c[0].data.action)
    expect(actions).toContain('stats')
    expect(actions).not.toContain('add') // 查询不记账
    expect(appendMock).toHaveBeenCalled() // 📊 模板回复出现
    expect(appendMock.mock.calls[0][0]).toContain('📊')
  })

  test('按分类统计 → 模型判 breakdown → tryQuery 走 stats（全部分类，不报错）', async () => {
    const inst = makeInst()
    jest.spyOn(inst, 'callModelForExtract').mockResolvedValue('{"action":"query","query":{"type":"breakdown"}}')
    await send(inst, '按分类统计支出')
    await sleep()

    const actions = callFunctionMock.mock.calls.map((c) => c[0].data.action)
    expect(actions).toContain('stats')
    expect(actions).not.toContain('add')
    expect(appendMock).toHaveBeenCalled()
    // 列出全部分类，不误报"没记过 XX"
    const msg = appendMock.mock.calls[0][0]
    expect(msg).toContain('按分类统计')
    expect(msg).not.toContain('还没记过')
  })
})

describe('B2 失败路径（callFunction reject / 模型降级失败）', () => {
  test('record: 网络超时 reject → 不插卡片 + toast「记账出错」', async () => {
    callFunctionMock.mockImplementation(() => Promise.reject(new Error('network timeout')))
    const inst = makeInst()
    defaultModelSpy(inst)
    await send(inst, '午饭38块')
    await sleep()

    expect(appendMock).not.toHaveBeenCalled() // 没假装成功
    expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '记账出错' }))
  })

  test('undo: list 网络 reject → 不插卡片 + toast「撤回出错」', async () => {
    callFunctionMock.mockImplementation(({ data }) => {
      if (data.action === 'list') return Promise.reject(new Error('list net'))
      return Promise.resolve({ result: { success: true } })
    })
    const inst = makeInst()
    jest.spyOn(inst, 'callModelForExtract').mockResolvedValue('{"action":"undo"}')
    await send(inst, '撤回')
    await sleep()

    expect(appendMock).not.toHaveBeenCalled()
    expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '撤回出错' }))
  })

  test('undo: list 成功但 delete 网络 reject → toast「撤回出错」，无撤回卡片', async () => {
    callFunctionMock.mockImplementation(({ data }) => {
      if (data.action === 'list') return Promise.resolve({ result: { success: true, list: [{ _id: 'x1', amount: -38, category: '餐饮' }] } })
      if (data.action === 'delete') return Promise.reject(new Error('delete net'))
      return Promise.resolve({ result: { success: true } })
    })
    const inst = makeInst()
    jest.spyOn(inst, 'callModelForExtract').mockResolvedValue('{"action":"undo"}')
    await send(inst, '撤回')
    await sleep()

    expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '撤回出错' }))
    expect(appendMock).not.toHaveBeenCalledWith(expect.stringContaining('🗑️'))
  })

  test('模型降级失败 → 保守不记账（无卡片、无 toast 刷屏）', async () => {
    const inst = makeInst()
    jest.spyOn(inst, 'callModelForExtract').mockRejectedValue(new Error('model net'))

    await send(inst, '嗯那个啥') // 正则 null → 模型失败 → decision null
    await sleep()

    const actions = callFunctionMock.mock.calls.map((c) => c[0].data.action)
    expect(actions).not.toContain('add') // 没尝试记账云函数
    expect(appendMock).not.toHaveBeenCalled() // 没确认卡片
    // 不应弹「记账出错」——模型降级应保守交给对话，而非报错刷屏
    expect(global.wx.showToast).not.toHaveBeenCalled()
  })

  test('模型判 chat（非记账）→ 不记、不插卡片（交给对话）', async () => {
    const inst = makeInst()
    jest.spyOn(inst, 'callModelForExtract').mockResolvedValue('{"action":"chat"}')

    await send(inst, '今天天气不错') // 正则 null → 模型 → chat
    await sleep()

    const actions = callFunctionMock.mock.calls.map((c) => c[0].data.action)
    expect(actions).not.toContain('add') // 没尝试记账
    // chat 分支：likelyNonChat 为 false（纯闲聊无正则命中）→ 不 suppress → 不 append 确定性卡片
    expect(appendMock).not.toHaveBeenCalled()
  })
})

describe('更正流程（correct 意图 → update 最近一笔）', () => {
  test('"想起来错了，是60" → 模型判 correct → update 被调，不新增 add', async () => {
    // getLastRecord 返回一笔火锅 -50
    callFunctionMock.mockImplementation(({ name, data }) => {
      if (name === 'miaojiRecord' && data.action === 'list') return Promise.resolve({ result: { success: true, list: [{ _id: 'last1', amount: -50, category: '餐饮', note: '火锅' }] } })
      if (name === 'miaojiRecord' && data.action === 'add') return Promise.resolve({ result: { success: true } })
      if (name === 'miaojiRecord' && data.action === 'update') return Promise.resolve({ result: { success: true, updated: 1 } })
      return Promise.resolve({ result: { success: false } })
    })
    const inst = makeInst()
    jest.spyOn(inst, 'callModelForExtract').mockResolvedValue('{"action":"correct","target":"last","amount":-60,"category":"餐饮","note":"火锅"}')

    await send(inst, '想起来错了，是60')
    await sleep()

    const actions = callFunctionMock.mock.calls.map((c) => c[0].data.action)
    expect(actions).toContain('update')
    expect(actions).not.toContain('add') // 更正不是新增
    expect(appendMock).toHaveBeenCalledWith(expect.stringContaining('✅ 已更正'))
    expect(appendMock).toHaveBeenCalledWith(expect.stringContaining('-¥60'))
  })
})

describe('查询回复 buildQueryReply（真实明细，不依赖模型编造）', () => {
  test('month 分支：从 records 拼真实逐笔明细（不编造）', () => {
    const inst = makeInst()
    const q = { type: 'month', month: 'this' }
    const result = {
      success: true,
      expenseTotal: -560,
      incomeTotal: 8000,
      net: 7440,
      count: 4,
      byCategory: [{ category: '餐饮', amount: -200 }, { category: '交通', amount: -360 }],
      records: [
        { _id: 'r1', amount: -360, type: 'expense', category: '交通', note: '打车', createdAt: new Date('2026-07-10T10:00:00') },
        { _id: 'r2', amount: -200, type: 'expense', category: '餐饮', note: '午饭', createdAt: new Date('2026-07-08T12:00:00') },
        { _id: 'r3', amount: 8000, type: 'income', category: '收入', note: '工资', createdAt: new Date('2026-07-01T09:00:00') },
        { _id: 'r4', amount: -0, type: 'expense', category: '其他', note: '', createdAt: new Date('2026-07-05T09:00:00') },
      ],
    }
    const msg = inst.buildQueryReply(q, result)
    expect(msg).toContain('这个月你一共花了 ¥560')
    expect(msg).toContain('收入 ¥8000')
    expect(msg).toContain('【交通】')
    expect(msg).toContain('打车 -¥360')
    expect(msg).toContain('【餐饮】')
    expect(msg).toContain('午饭 -¥200')
    expect(msg).toContain('7月10日')
    expect(msg).toContain('7月8日')
    expect(msg).toContain('+¥8000')
    expect(msg).not.toContain('1280') // 此前模型幻觉的数字，锁死
  })

  test('month 分支：count=0 → 提示未记账（无明细）', () => {
    const inst = makeInst()
    const q = { type: 'month', month: 'this' }
    const result = { success: true, expenseTotal: 0, incomeTotal: 0, net: 0, count: 0, byCategory: [], records: [] }
    expect(inst.buildQueryReply(q, result)).toContain('这个月还没记账呢')
  })

  test('breakdown 分支：列出所有分类支出（不误报"没记过其他"）', () => {
    const inst = makeInst()
    const q = { type: 'breakdown' }
    const result = {
      success: true,
      expenseTotal: -580,
      byCategory: [
        { category: '餐饮', amount: -200, count: 3 },
        { category: '交通', amount: -360, count: 2 },
        { category: '其他', amount: -20, count: 1 },
      ],
      count: 6,
    }
    const msg = inst.buildQueryReply(q, result)
    expect(msg).toContain('按分类统计')
    expect(msg).toContain('餐饮')
    expect(msg).toContain('交通')
    expect(msg).toContain('其他') // 即使金额小也列出，不报"没记过"
    expect(msg).not.toContain('还没记过') // 修复前对 0 分类说"没记过"的回归锁
  })

  test('breakdown 分支：某分类金额为 0 也列出（不漏）', () => {
    const inst = makeInst()
    const q = { type: 'breakdown' }
    const result = {
      success: true,
      expenseTotal: -200,
      byCategory: [{ category: '餐饮', amount: -200, count: 2 }, { category: '其他', amount: 0, count: 0 }],
      count: 2,
    }
    const msg = inst.buildQueryReply(q, result)
    expect(msg).toContain('餐饮')
    expect(msg).toContain('其他')
    expect(msg).not.toContain('还没记过「其他」')
  })
})
