// A2: 拍照记账集成测试
// 验证 onPhotoAccount 流程：chooseMedia → uploadFile → callFunction(ocr) → 确认弹窗 → 确认 → doAdd
//
// mock 说明：
//   - wx.chooseMedia：返回测试图 tempFilePath
//   - wx.cloud.uploadFile：返回云存储 fileID
//   - wx.cloud.callFunction：
//       action='ocr'  → 返回 qwen3.5-flash 识别结果（{amount, merchant, category, date}）
//       action='add'  → 返回成功

const callFunctionMock = jest.fn()
const uploadFileMock = jest.fn()
const chooseMediaMock = jest.fn()
const appendMock = jest.fn()
const showToastMock = jest.fn()

beforeAll(() => {
  global.wx = {
    cloud: {
      callFunction: callFunctionMock,
      uploadFile: uploadFileMock,
    },
    chooseMedia: chooseMediaMock,
    showToast: showToastMock,
  }
})

let pageOpts
beforeAll(() => {
  global.Page = (opts) => { pageOpts = opts }
  require('../../miniprogram/pages/chatBot/chatBot.js')
})

function makeInst() {
  const inst = Object.assign({}, pageOpts.data)
  Object.keys(pageOpts).forEach((k) => {
    if (k === 'data') return
    if (typeof pageOpts[k] === 'function') inst[k] = pageOpts[k].bind(inst)
  })
  inst._history = []
  inst._ctx = null
  inst.data = Object.assign({}, pageOpts.data, { _history: [], _ctx: null })
  inst.setData = jest.fn((patch) => {
    Object.assign(inst.data, patch)
    Object.assign(inst, patch)
  })
  inst.selectComponent = jest.fn().mockReturnValue({ appendAssistantMessage: appendMock })
  return inst
}

const sleep = (ms = 20) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  callFunctionMock.mockReset()
  uploadFileMock.mockReset()
  chooseMediaMock.mockReset()
  appendMock.mockReset()
  showToastMock.mockReset()

  // 默认：上传成功 + OCR 识别成功 + add 成功
  chooseMediaMock.mockImplementation(({ success }) =>
    success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_photo.png', size: 1024 }] })
  )
  uploadFileMock.mockResolvedValue({ fileID: 'cloud://seclog/tmp/photo.png' })
  callFunctionMock.mockImplementation(({ name, data }) => {
    if (name === 'miaojiRecord' && data.action === 'ocr') {
      return Promise.resolve({
        result: { success: true, amount: 45.5, merchant: 'SUPERMARKET', category: '购物', date: '2026-07-15' },
      })
    }
    if (name === 'miaojiRecord' && data.action === 'add') {
      return Promise.resolve({ result: { success: true } })
    }
    return Promise.resolve({ result: { success: false } })
  })
})

describe('A2 拍照记账：onPhotoAccount → OCR → 确认 → 记账', () => {
  test('拍照 → 上传 → OCR 识别 → 弹窗出现（含识别金额/类别）', async () => {
    const inst = makeInst()
    await inst.onPhotoAccount()
    await sleep()

    // 1. 上传被调用
    expect(uploadFileMock).toHaveBeenCalledTimes(1)
    // 2. OCR 云函数被调用（传 fileID）
    const ocrCall = callFunctionMock.mock.calls.find((c) => c[0].data.action === 'ocr')
    expect(ocrCall).toBeDefined()
    expect(ocrCall[0].data.payload.imageUrl).toContain('cloud://')
    // 3. 确认弹窗状态置为 true，且识别结果填入
    expect(inst.data.showOcrModal).toBe(true)
    expect(inst.data.ocrResult.amount).toBe('45.5')
    expect(inst.data.ocrResult.category).toBe('购物')
    expect(inst.data.ocrResult.merchant).toBe('SUPERMARKET')
    // 4. 尚未记账（add 未被调用，等用户确认）
    const addCall = callFunctionMock.mock.calls.find((c) => c[0].data.action === 'add')
    expect(addCall).toBeUndefined()
  })

  test('用户确认 → doAdd 被调（amount/category/note 正确）', async () => {
    const inst = makeInst()
    await inst.onPhotoAccount()
    await sleep()
    expect(inst.data.showOcrModal).toBe(true)

    // 用户点确认
    await inst.onOcrConfirm()
    await sleep()

    // 弹窗关闭
    expect(inst.data.showOcrModal).toBe(false)
    // add 被调用，且金额/类别/商家(note)正确
    const addCall = callFunctionMock.mock.calls.find((c) => c[0].data.action === 'add')
    expect(addCall).toBeDefined()
    expect(addCall[0].data.payload.amount).toBe(45.5)
    expect(addCall[0].data.payload.category).toBe('购物')
    expect(addCall[0].data.payload.note).toBe('SUPERMARKET')
    // 对话流出现记账确认
    expect(appendMock).toHaveBeenCalled()
    expect(appendMock.mock.calls[appendMock.mock.calls.length - 1][0]).toContain('[已记]')
  })

  test('用户取消 → 不记账，弹窗关闭', async () => {
    const inst = makeInst()
    await inst.onPhotoAccount()
    await sleep()
    expect(inst.data.showOcrModal).toBe(true)

    await inst.onOcrCancel()
    await sleep()

    expect(inst.data.showOcrModal).toBe(false)
    expect(inst.data.ocrResult).toBeNull()
    const addCall = callFunctionMock.mock.calls.find((c) => c[0].data.action === 'add')
    expect(addCall).toBeUndefined()
  })

  test('OCR 失败 → toast 提示，不弹窗', async () => {
    callFunctionMock.mockImplementation(({ name, data }) => {
      if (name === 'miaojiRecord' && data.action === 'ocr') {
        return Promise.resolve({ result: { success: false, code: 'AI_PARSE_ERROR', message: '识别失败' } })
      }
      return Promise.resolve({ result: { success: false } })
    })
    const inst = makeInst()
    await inst.onPhotoAccount()
    await sleep()

    expect(inst.data.showOcrModal).toBe(false)
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: '识别失败' }))
    const addCall = callFunctionMock.mock.calls.find((c) => c[0].data.action === 'add')
    expect(addCall).toBeUndefined()
  })

  test('选择图片取消 → 不触发上传/OCR', async () => {
    chooseMediaMock.mockImplementation(({ fail }) => fail({ errMsg: 'chooseImage:fail cancel' }))
    const inst = makeInst()
    await inst.onPhotoAccount()
    await sleep()

    expect(uploadFileMock).not.toHaveBeenCalled()
    expect(callFunctionMock).not.toHaveBeenCalled()
  })
})
