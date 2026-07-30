// utils/__tests__/deleteResult.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { checkDeleteResult } = require('../deleteResult')

test('removed=1 → ok', () => {
  assert.equal(checkDeleteResult({ result: { success: true, removed: 1 } }), 'ok')
})

test('removed=2 → ok（多条）', () => {
  assert.equal(checkDeleteResult({ result: { success: true, removed: 2 } }), 'ok')
})

test('removed=0 + success=true → not-found（owner 不匹配 / 已删）', () => {
  assert.equal(checkDeleteResult({ result: { success: true, removed: 0 } }), 'not-found')
})

test('removed 字段缺失 → not-found', () => {
  assert.equal(checkDeleteResult({ result: { success: true } }), 'not-found')
})

test('success=false → fail', () => {
  assert.equal(checkDeleteResult({ result: { success: false, code: 'X' } }), 'fail')
})

test('result 缺失 → fail', () => {
  assert.equal(checkDeleteResult({}), 'fail')
})

test('null → fail', () => {
  assert.equal(checkDeleteResult(null), 'fail')
})

test('undefined → fail', () => {
  assert.equal(checkDeleteResult(undefined), 'fail')
})

test('del.result.removed 负数 → not-found', () => {
  // 防御性：负数视为异常，按未删处理
  assert.equal(checkDeleteResult({ result: { success: true, removed: -1 } }), 'not-found')
})
