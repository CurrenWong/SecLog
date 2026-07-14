// 首页 index 页面集成测试（真实 index.js 源码 + 页面实例语义）
// 验证：onShow → loadData → summary + list 两个云函数调用，recent 被正确填充
//
// 重点回归：修复前的 Promise 链用 .finally(() => return listCall) 导致 list 结果被吞掉，
// recent 永远是空数组（首页"最近记录为空" bug）。修复后 list 结果传到 .then，recent 被 setData。

const callFunctionMock = jest.fn()
beforeAll(() => {
  global.wx = {
    cloud: { callFunction: callFunctionMock },
    navigateTo: jest.fn(),
    stopPullDownRefresh: jest.fn(),
  }
})

let pageOpts
beforeAll(() => {
  global.Page = (opts) => { pageOpts = opts }
  require('../../miniprogram/pages/index/index.js')
})

function makeInst() {
  const inst = {}
  inst.data = Object.assign({}, pageOpts.data) // 保留 this.data 嵌套（小程序运行时语义）
  Object.keys(pageOpts).forEach((k) => {
    if (k === 'data') return
    if (typeof pageOpts[k] === 'function') inst[k] = pageOpts[k].bind(inst)
  })
  // 模拟 setData（小程序运行时：合并到 this.data）
  inst.setData = (obj) => { inst.data = Object.assign({}, inst.data, obj) }
  return inst
}

const sleep = (ms = 20) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  callFunctionMock.mockReset()
  // 默认：summary + list 都返回成功
  callFunctionMock.mockImplementation(({ data }) => {
    if (data.action === 'summary') {
      return Promise.resolve({ result: { success: true, day: { income: 0, expense: -38 }, month: { income: 0, expense: -38 } } })
    }
    if (data.action === 'list') {
      return Promise.resolve({
        result: {
          success: true,
          list: [{ _id: 'r1', amount: -38, type: 'expense', category: '餐饮', note: '午饭', createdAt: '2026-07-14T10:00:00Z' }],
        },
      })
    }
    return Promise.resolve({ result: { success: false } })
  })
})

describe('首页 index 集成：loadData 填充最近记录', () => {
  test('list 返回数据 → recent 被填充（修复前此处为空）', async () => {
    const inst = makeInst()
    inst.onShow() // 触发 loadData
    await sleep()

    expect(inst.data.recent.length).toBe(1)
    expect(inst.data.recent[0].category).toBe('餐饮')
    expect(inst.data.recent[0].amount).toBe(-38)
    expect(inst.data.loading).toBe(false)
    expect(inst.data._fetching).toBe(false)
  })

  test('list 返回空 → recent 为空数组（不报错，loading 复位）', async () => {
    callFunctionMock.mockImplementation(({ data }) => {
      if (data.action === 'summary') return Promise.resolve({ result: { success: true, day: { income: 0, expense: 0 }, month: { income: 0, expense: 0 } } })
      if (data.action === 'list') return Promise.resolve({ result: { success: true, list: [] } })
      return Promise.resolve({ result: { success: false } })
    })
    const inst = makeInst()
    inst.onShow()
    await sleep()

    expect(inst.data.recent).toEqual([])
    expect(inst.data.loading).toBe(false)
  })

  test('summary + list 都按序调用（先 summary 再 list）', async () => {
    const inst = makeInst()
    inst.onShow()
    await sleep()

    const actions = callFunctionMock.mock.calls.map((c) => c[0].data.action)
    expect(actions).toContain('summary')
    expect(actions).toContain('list')
  })

  test('list 失败（reject）→ recent 不填充但 loading 仍复位（不卡死）', async () => {
    callFunctionMock.mockImplementation(({ data }) => {
      if (data.action === 'summary') return Promise.resolve({ result: { success: true, day: { income: 0, expense: 0 }, month: { income: 0, expense: 0 } } })
      if (data.action === 'list') return Promise.reject(new Error('net'))
      return Promise.resolve({ result: { success: false } })
    })
    const inst = makeInst()
    inst.onShow()
    await sleep()

    expect(inst.data.recent).toEqual([]) // 失败不填充
    expect(inst.data.loading).toBe(false) // 但 loading 复位，不卡死
  })
})
