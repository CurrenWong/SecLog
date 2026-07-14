// A1: chatBot 页面级集成测试（真实 chatBot.js 源码 + 页面实例语义）
//
// 说明：miniprogram-simulate 是组件测试框架，不注入 Page 全局，无法直接 load 用 Page() 的页面。
// 因此这里用「注入 global.Page 捕获页面配置 → 构造页面实例」的方式，跑真实 chatBot.js 的逻辑，
// 验证：
//   1) 对话流出现 ✅ 确认卡片（selectComponent('#agentui').appendAssistantMessage 收到正确文案）
//   2) 记账云函数被调用（wx.cloud.callFunction add）
//   3) 失败 / 撤回 / 更正 分支行为正确
//
// 新架构：tryRecord 总是先 getLastRecord(list) 供模型判断更正，再调模型最终拍板（add/correct/none）。

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
    if (name === 'miaojiRecord' && data.action === 'list') return Promise.resolve({ result: { success: true, list: [{ _id: 'x1', amount: -38, category: '餐饮' }] } })
    if (name === 'miaojiRecord' && data.action === 'delete') return Promise.resolve({ result: { success: true, removed: 1 } })
    if (name === 'miaojiRecord' && data.action === 'update') return Promise.resolve({ result: { success: true, updated: 1 } })
    return Promise.resolve({ result: { success: false } })
  })
})

// 默认模型回复：add 确认（测试可覆盖）
function defaultModelSpy(inst, returnText = '{"action":"add","amount":-38,"category":"餐饮","note":"午饭"}') {
  return jest.spyOn(inst, 'callModelForExtract').mockResolvedValue(returnText)
}

describe('A1 chatBot 页面集成：发消息 → 对话流出现 ✅ 卡片', () => {
  test('确定值"午饭38块" → appendAssistantMessage 收到 ✅ 确认，云函数 add 被调，模型做最终拍板', async () => {
    const inst = makeInst()
    const modelSpy = defaultModelSpy(inst)

    await inst.tryRecord('午饭38块')
    await sleep()

    // 对话流出现唯一确认卡片
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
    // 新架构：即使确定值也调模型做最终拍板（正则结果作为线索）
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
    await inst.tryRecord('打车45')
    await sleep()

    expect(appendMock).not.toHaveBeenCalled() // 失败不插确认
    expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '记账失败' }))
  })

  test('onUserSend 先判撤回意图 → 走 tryUndo 而非 tryRecord', async () => {
    const inst = makeInst()
    inst.onUserSend({ detail: { content: '撤回' } })
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

  test('onUserSend 消费意图 → 走 tryRecord（记账）', async () => {
    const inst = makeInst()
    defaultModelSpy(inst)
    inst.onUserSend({ detail: { content: '午饭38块' } })
    await sleep()

    const actions = callFunctionMock.mock.calls.map((c) => c[0].data.action)
    expect(actions).toContain('add')
    expect(appendMock).toHaveBeenCalled()
    expect(appendMock.mock.calls[0][0]).toContain('✅ 已记')
  })
})

describe('B2 失败路径（callFunction reject / 模型降级失败）', () => {
  test('tryRecord: 网络超时 reject → 不插卡片 + toast「记账出错」', async () => {
    callFunctionMock.mockImplementation(() => Promise.reject(new Error('network timeout')))
    const inst = makeInst()
    defaultModelSpy(inst)
    await inst.tryRecord('午饭38块')
    await sleep()

    expect(appendMock).not.toHaveBeenCalled() // 没假装成功
    expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '记账出错' }))
  })

  test('tryUndo: list 网络 reject → 不插卡片 + toast「撤回出错」', async () => {
    callFunctionMock.mockImplementation(({ data }) => {
      if (data.action === 'list') return Promise.reject(new Error('list net'))
      return Promise.resolve({ result: { success: true } })
    })
    const inst = makeInst()
    inst.onUserSend({ detail: { content: '撤回' } })
    await sleep()

    expect(appendMock).not.toHaveBeenCalled()
    expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '撤回出错' }))
  })

  test('tryUndo: list 成功但 delete 网络 reject → toast「撤回出错」，无撤回卡片', async () => {
    callFunctionMock.mockImplementation(({ data }) => {
      if (data.action === 'list') return Promise.resolve({ result: { success: true, list: [{ _id: 'x1', amount: -38, category: '餐饮' }] } })
      if (data.action === 'delete') return Promise.reject(new Error('delete net'))
      return Promise.resolve({ result: { success: true } })
    })
    const inst = makeInst()
    inst.onUserSend({ detail: { content: '撤回' } })
    await sleep()

    expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '撤回出错' }))
    expect(appendMock).not.toHaveBeenCalledWith(expect.stringContaining('🗑️'))
  })

  test('tryRecord: 正则 null + 模型降级失败 → 静默不记账（无卡片、无 toast）', async () => {
    // 模拟：正则抽不到（模糊闲聊），大模型通道也失败 → decision 变 null → 不记账
    const inst = makeInst()
    jest.spyOn(inst, 'callModelForExtract').mockRejectedValue(new Error('model net'))

    await inst.tryRecord('嗯那个啥') // 无消费意图词 → 正则 null → 走模型 → 失败
    await sleep()

    // getLastRecord 的 list 调用可能成功，但不应有 add
    const actions = callFunctionMock.mock.calls.map((c) => c[0].data.action)
    expect(actions).not.toContain('add') // 没尝试记账云函数
    expect(appendMock).not.toHaveBeenCalled() // 没确认卡片
    // 不应弹「记账出错」——用户只是说了句模糊话，应交给模型正常对话，而非报错刷屏
    expect(global.wx.showToast).not.toHaveBeenCalled()
  })

  test('tryRecord: 正则 null + 模型确认非记账(none) → 不记、不插卡片（交给对话）', async () => {
    // 正则抽不到，调模型 → 模型返回 {action:"none"}
    // 真实 tryRecord 应明确 return，不记账、不插卡片，由 agent-ui 模型对话接管（闲聊）
    const inst = makeInst()
    jest.spyOn(inst, 'callModelForExtract').mockResolvedValue('{"action":"none"}')

    await inst.tryRecord('今天天气不错') // 正则 null → 模型 → none
    await sleep()

    const actions = callFunctionMock.mock.calls.map((c) => c[0].data.action)
    expect(actions).not.toContain('add') // 没尝试记账
    expect(appendMock).not.toHaveBeenCalled() // 没确认卡片（区分于"记成功"）
  })
})

describe('更正流程（correct 意图 → update 最近一笔）', () => {
  test('"想起来错了，是60" → update 被调，不新增 add', async () => {
    // getLastRecord 返回一笔火锅 -50
    callFunctionMock.mockImplementation(({ name, data }) => {
      if (name === 'miaojiRecord' && data.action === 'list') return Promise.resolve({ result: { success: true, list: [{ _id: 'last1', amount: -50, category: '餐饮', note: '火锅' }] } })
      if (name === 'miaojiRecord' && data.action === 'add') return Promise.resolve({ result: { success: true } })
      if (name === 'miaojiRecord' && data.action === 'update') return Promise.resolve({ result: { success: true, updated: 1 } })
      return Promise.resolve({ result: { success: false } })
    })
    const inst = makeInst()
    jest.spyOn(inst, 'callModelForExtract').mockResolvedValue('{"action":"correct","target":"last","amount":-60,"category":"餐饮","note":"火锅"}')

    await inst.tryRecord('想起来错了，是60')
    await sleep()

    const actions = callFunctionMock.mock.calls.map((c) => c[0].data.action)
    expect(actions).toContain('update')
    expect(actions).not.toContain('add') // 更正不是新增
    expect(appendMock).toHaveBeenCalledWith(expect.stringContaining('✅ 已更正'))
    expect(appendMock).toHaveBeenCalledWith(expect.stringContaining('-¥60'))
  })
})
