// utils/__tests__/dateRange.test.js
// 项目内单测。运行：node miniprogram/utils/__tests__/dateRange.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { computeCurrentMonthDays } = require('../dateRange')

test('月初 1 号返回 1', () => {
  // 2026-07-01 (本月起始)
  assert.equal(computeCurrentMonthDays(new Date(2026, 6, 1, 0, 0, 1)), 1)
})

test('月中返回正确天数', () => {
  // 2026-07-15 = 15 号
  assert.equal(computeCurrentMonthDays(new Date(2026, 6, 15, 12, 0, 0)), 15)
})

test('月末 31 号返回 31', () => {
  // 2026-07-31
  assert.equal(computeCurrentMonthDays(new Date(2026, 6, 31, 23, 59, 59)), 31)
})

test('2 月非闰年（28 天）', () => {
  // 2026-02-28 (2026 非闰年)
  assert.equal(computeCurrentMonthDays(new Date(2026, 1, 28, 10, 0, 0)), 28)
})

test('跨年：1 月 1 日 = 1', () => {
  // 2026-01-01
  assert.equal(computeCurrentMonthDays(new Date(2026, 0, 1, 0, 0, 1)), 1)
})

test('与查账页面本月口径一致（关键验证）', () => {
  // 模拟 2026-07-27 = 27 号
  const days = computeCurrentMonthDays(new Date(2026, 6, 27, 14, 0, 0))
  // = 27（7 月 1 号到 7 月 27 = 27 天，含两端）
  assert.equal(days, 27)
})

test('不带参数也安全（用真实当前时间）', () => {
  const days = computeCurrentMonthDays()
  const now = new Date()
  const expected = Math.floor((now.getTime() - new Date(now.getFullYear(), now.getMonth(), 1).getTime()) / 86400000) + 1
  assert.equal(days, expected)
})
