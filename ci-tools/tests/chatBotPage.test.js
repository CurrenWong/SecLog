// A1: chatBot 页面级集成测试（真实 chatBot.js 源码 + 页面实例语义）
//
// 说明：miniprogram-simulate 是组件测试框架，不注入 Page 全局，无法直接 load 用 Page() 的页面。
// 因此这里用「注入 global.Page 捕获页面配置 → 构造页面实例」的方式，跑真实 chatBot.js 的逻辑，
// 验证：
//   1) 对话流出现 ✅ 确认卡片（selectComponent('#agentui').appendAssistantMessage 收到正确文案）
//   2) 记账云函数被调用（wx.cloud.callFunction add）
//   3) 确定值不调大模型（callModelForExtract 未被触发）
//   4) 失败 / 撤回 分支行为正确
//
// 这是比纯逻辑测（chatBot.test.js 复刻）更进一层的「页面实例集成」验证，用的是未改动的源码。

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

beforeEach(() => {
  callFunctionMock.mockReset()
  appendMock.mockReset()
  global.wx.showToast.mockReset()
  callFunctionMock.mockImplementation(({ name, data }) => {
    if (name === 'miaojiRecord' && data.action === 'add') return Promise.resolve({ result: { success: true } })
    if (name === 'miaojiRecord' && data.action === 'list') return Promise.resolve({ result: { success: true, list: [{ _id: 'x1', amount: -38, category: '餐饮' }] } })
    if (name === 'miaojiRecord' && data.action === 'delete') return Promise.resolve({ result: { success: true, removed: 1 } })
    return Promise.resolve({ result: { success: false } })
  })
})

describe('A1 chatBot 页面集成：发消息 → 对话流出现 ✅ 卡片', () => {
  test('确定值"午饭38块" → appendAssistantMessage 收到 ✅ 确认，云函数 add 被调，未调模型', async () => {
    const inst = makeInst()
    const modelSpy = jest.spyOn(inst, 'callModelForExtract')

    await inst.tryRecord('午饭38块')
    await new Promise((r) => setTimeout(r, 20)) // 等 callFunction.then 异步完成

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
    // 确定值走正则，未降级调模型
    expect(modelSpy).not.toHaveBeenCalled()
  })

  test('云函数 add 失败 → 不追加确认卡片，toast 失败', async () => {
    callFunctionMock.mockImplementation(({ name, data }) => {
      if (name === 'miaojiRecord' && data.action === 'add') return Promise.resolve({ result: { success: false } })
      return Promise.resolve({ result: { success: false } })
    })
    const inst = makeInst()
    await inst.tryRecord('打车45')
    await new Promise((r) => setTimeout(r, 20))

    expect(appendMock).not.toHaveBeenCalled() // 失败不插确认
    expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '记账失败' }))
  })

  test('onUserSend 先判撤回意图 → 走 tryUndo 而非 tryRecord', async () => {
    const inst = makeInst()
    inst.onUserSend({ detail: { content: '记错了' } })
    await new Promise((r) => setTimeout(r, 20))

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
    inst.onUserSend({ detail: { content: '午饭38块' } })
    await new Promise((r) => setTimeout(r, 20))

    const actions = callFunctionMock.mock.calls.map((c) => c[0].data.action)
    expect(actions).toContain('add')
    expect(appendMock).toHaveBeenCalled()
    expect(appendMock.mock.calls[0][0]).toContain('✅ 已记')
  })
})

// B2: 失败路径（网络/传输层 reject，区别于业务层 success:false）
// 核心断言：失败时【绝不】插入确认卡片（不能假装成功），并弹对应错误 toast。
describe('B2 失败路径（callFunction reject / 模型降级失败）', () => {
  test('tryRecord: 网络超时 reject → 不插卡片 + toast「记账出错」', async () => {
    callFunctionMock.mockImplementation(() => Promise.reject(new Error('network timeout')))
    const inst = makeInst()
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
    inst.onUserSend({ detail: { content: '记错了' } })
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
    inst.onUserSend({ detail: { content: '记错了' } })
    await sleep()

    expect(global.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '撤回出错' }))
    expect(appendMock).not.toHaveBeenCalledWith(expect.stringContaining('🗑️'))
  })

  test('tryRecord: 正则 null + 模型降级失败 → 静默不记账（无卡片、无 toast）', async () => {
    // 模拟：正则抽不到（模糊闲聊），大模型通道也失败 → parsed 变 null → 不记账
    const inst = makeInst()
    jest.spyOn(inst, 'callModelForExtract').mockRejectedValue(new Error('model net'))

    await inst.tryRecord('嗯那个啥') // 无消费意图词 → 正则 null → 走模型 → 失败
    await sleep()

    expect(callFunctionMock).not.toHaveBeenCalled() // 没尝试记账云函数
    expect(appendMock).not.toHaveBeenCalled() // 没确认卡片
    // 注意：不应弹「记账出错」——用户只是说了句模糊话，应交给模型正常对话，而非报错刷屏
    expect(global.wx.showToast).not.toHaveBeenCalled()
  })
})
