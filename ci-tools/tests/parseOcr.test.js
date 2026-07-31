// parseOcr.test.js
// 测试 cloudfunctions/miaojiRecord/parseOcr.js（云函数用的纯 JSON 容错解析 + 字段归一化）
// 跑：node_modules/.bin/jest tests/parseOcr.test.js

const { test, expect, describe } = require('@jest/globals')
const { parseOcrResponse, extractJsonString, CATEGORY_ENUM } = require('../../cloudfunctions/miaojiRecord/parseOcr')

describe('extractJsonString', () => {
  test('纯 JSON 字符串原样返回', () => {
    expect(extractJsonString('{"amount":45.5}')).toBe('{"amount":45.5}')
  })

  test('去掉 ```json ... ``` 包裹', () => {
    expect(extractJsonString('```json\n{"amount":45.5}\n```')).toBe('{"amount":45.5}')
  })

  test('去掉 ``` ... ``` 包裹（无语言标记）', () => {
    expect(extractJsonString('```\n{"amount":45.5}\n```')).toBe('{"amount":45.5}')
  })

  test('从杂讯里抠出第一个 {..}', () => {
    expect(extractJsonString('好的，这是识别结果：{"amount":45.5,"merchant":"全家"}。')).toContain('"amount":45.5')
  })

  test('空字符串返回 null', () => {
    expect(extractJsonString('')).toBe(null)
    expect(extractJsonString(null)).toBe(null)
    expect(extractJsonString(undefined)).toBe(null)
  })

  test('多行 JSON（含换行）正确处理', () => {
    const input = '```json\n{\n  "amount": 76.80,\n  "merchant": "x"\n}\n```'
    const out = extractJsonString(input)
    expect(JSON.parse(out)).toEqual({ amount: 76.80, merchant: 'x' })
  })
})

describe('parseOcrResponse', () => {
  test('正常 JSON → 字段正确', () => {
    const r = parseOcrResponse('{"amount":45.5,"merchant":"全家便利店","category":"购物","date":"2026-07-15"}')
    expect(r).toEqual({ ok: true, amount: 45.5, merchant: '全家便利店', category: '购物', date: '2026-07-15' })
  })

  test('代码块包裹 → 容错剥离', () => {
    const r = parseOcrResponse('```json\n{"amount":76.80,"merchant":"影城","category":"娱乐","date":"2026-07-31"}\n```')
    expect(r.ok).toBe(true)
    expect(r.amount).toBe(76.80)
    expect(r.category).toBe('娱乐')
  })

  test('非法 category → 兜底为 "其他"（不在枚举里）', () => {
    const r = parseOcrResponse('{"amount":45,"category":"文化休闲"}')
    expect(r.category).toBe('其他')
  })

  test('amount 是字符串 → 归一为 null', () => {
    const r = parseOcrResponse('{"amount":"45","category":"购物"}')
    expect(r.amount).toBe(null)
  })

  test('amount 缺失 → null', () => {
    const r = parseOcrResponse('{"merchant":"x","category":"购物"}')
    expect(r.amount).toBe(null)
  })

  test('merchant 缺失 → 空串', () => {
    const r = parseOcrResponse('{"amount":10,"category":"购物"}')
    expect(r.merchant).toBe('')
  })

  test('date 缺失 → 空串', () => {
    const r = parseOcrResponse('{"amount":10,"category":"购物"}')
    expect(r.date).toBe('')
  })

  test('坏 JSON → AI_PARSE_ERROR', () => {
    const r = parseOcrResponse('{"amount":45, "category":}')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('AI_PARSE_ERROR')
    expect(r.raw).toBeDefined()
  })

  test('空字符串 → AI_EMPTY', () => {
    const r = parseOcrResponse('')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('AI_EMPTY')
  })

  test('null/undefined → AI_EMPTY', () => {
    expect(parseOcrResponse(null).code).toBe('AI_EMPTY')
    expect(parseOcrResponse(undefined).code).toBe('AI_EMPTY')
  })

  test('所有枚举值都被允许', () => {
    for (const cat of CATEGORY_ENUM) {
      const r = parseOcrResponse(`{"amount":10,"category":"${cat}"}`)
      expect(r.category).toBe(cat)
    }
  })

  // 真实场景：支付宝账单详情页 UI 截图 → prompt 改后预期结果
  test('支付宝详情页真实场景 → 完整字段识别', () => {
    const r = parseOcrResponse('{"amount":76.80,"merchant":"保利国际影城上海唐镇店","category":"娱乐","date":"2026-07-31"}')
    expect(r).toEqual({
      ok: true,
      amount: 76.80,
      merchant: '保利国际影城上海唐镇店',
      category: '娱乐',
      date: '2026-07-31',
    })
  })

  // 边界：模型可能返回字符串里的数字（部分模型抽飞），归一为 null
  test('amount 是字符串 "76.80" → 归一为 null（不静默转换，避免脏数据）', () => {
    const r = parseOcrResponse('{"amount":"76.80","category":"娱乐"}')
    expect(r.amount).toBe(null)
  })

  test('JSON 数组（不是对象）→ AI_PARSE_ERROR', () => {
    const r = parseOcrResponse('[1,2,3]')
    expect(r.ok).toBe(false)
  })
})