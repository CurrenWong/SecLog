// utils/__tests__/fallbackHint.test.js
// 项目内单测。运行：node miniprogram/utils/__tests__/fallbackHint.test.js
// 或：npm test（如果 package.json 配了 scripts.test）
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildFallbackHint, buildBlankFallbackHint } = require('../fallbackHint')

test('undo 优先于其他 hint', () => {
  const out = buildFallbackHint({ undoHint: true, regexExpense: { amount: -38, category: '餐饮' } })
  assert.match(out, /撤回/)
})

test('record 支出反问', () => {
  const out = buildFallbackHint({ regexExpense: { amount: -38, category: '餐饮', note: '午饭' } })
  assert.match(out, /餐饮/)
  assert.match(out, /-¥38/)
  assert.match(out, /午饭/)
})

test('record 收入反问', () => {
  const out = buildFallbackHint({ regexExpense: { amount: 1000, category: '收入', note: '工资' } })
  assert.match(out, /收入/)
  assert.match(out, /¥1000/)
})

test('query day', () => {
  const out = buildFallbackHint({ queryHint: { type: 'day' } })
  assert.match(out, /今天/)
})

test('query category', () => {
  const out = buildFallbackHint({ queryHint: { type: 'category', category: '交通' } })
  assert.match(out, /交通/)
})

test('query recent', () => {
  const out = buildFallbackHint({ queryHint: { type: 'recent' } })
  assert.match(out, /明细/)
})

test('query range 年份', () => {
  const out = buildFallbackHint({ queryHint: { type: 'range', range: { mode: 'year', year: 2026 } } })
  assert.match(out, /2026年/)
})

test('query range label=昨天', () => {
  const out = buildFallbackHint({ queryHint: { type: 'range', rangeLabel: '昨天' } })
  assert.match(out, /昨天/)
})

test('query range lastN', () => {
  const out = buildFallbackHint({ queryHint: { type: 'range', range: { mode: 'lastN', days: 7 } } })
  assert.match(out, /最近7天/)
})

test('query range between', () => {
  const out = buildFallbackHint({ queryHint: { type: 'range', range: { mode: 'between', from: '2026-01-01', to: '2026-06-30' } } })
  assert.match(out, /2026-01-01 ~ 2026-06-30/)
})

test('query month 兜底', () => {
  const out = buildFallbackHint({ queryHint: { type: 'month' } })
  assert.match(out, /这个月/)
})

test('全部空 hint 走兜底', () => {
  const out = buildFallbackHint({})
  assert.match(out, /没太明白/)
})

// —— 全空白兜底：likelyNonChat=false + 模型失败/沉默 ——
// chatBot 在 !decision 且 !likelyNonChat 时调用这个，替代了"空白回复"。
test('buildBlankFallbackHint 包含记账引导', () => {
  const out = buildBlankFallbackHint()
  assert.match(out, /记账/)
  assert.match(out, /午饭 38/)
  assert.match(out, /滴滴 17.7/)
})

test('buildBlankFallbackHint 包含查账引导', () => {
  const out = buildBlankFallbackHint()
  assert.match(out, /查账/)
  assert.match(out, /这个月花了多少/)
})

test('buildBlankFallbackHint 包含撤回引导', () => {
  const out = buildBlankFallbackHint()
  assert.match(out, /撤回/)
  assert.match(out, /「撤回」/)
})

test('buildBlankFallbackHint 不空白（长度 > 20）', () => {
  const out = buildBlankFallbackHint()
  assert.ok(out.length > 20, '兜底提示必须给用户实质内容')
})

test('buildBlankFallbackHint 与 buildFallbackHint 是不同函数（场景区分）', () => {
  // 同样的"全空 hints"输入：
  //   buildFallbackHint({}) → "没太明白" 短引导（likelyNonChat=true 但无 hint）
  //   buildBlankFallbackHint() → 完整意图清单（likelyNonChat=false）
  // 两条消息应有不同形态（前者短、后者有列表）
  const short = buildFallbackHint({})
  const blank = buildBlankFallbackHint()
  assert.ok(blank.length > short.length, '全空白兜底应比短引导更长')
})

test('record 优先于 query', () => {
  const out = buildFallbackHint({ regexExpense: { amount: -38, category: '餐饮' }, queryHint: { type: 'day' } })
  assert.match(out, /餐饮/)
  assert.doesNotMatch(out, /今天/)
})
