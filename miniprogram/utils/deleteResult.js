// utils/deleteResult.js
// 解析云函数 delete 返回值，给前端明确的删除结果分支。
//
// 历史坑：之前前端只检查 `success: true` 就 toast「已删除」，
// 但云函数的 `db.collection.where({_id, openid}).remove()` 在 owner 不匹配时
// 返回 `{ success: true, removed: 0 }` —— 用户以为删了，数据库还在。
// 必须严格区分 ok / not-found / fail 三态。

/**
 * @param {{result?: {success?: boolean, removed?: number, code?: string, message?: string}}} del 云函数响应
 * @returns {'ok'|'not-found'|'fail'} 'ok' = 真删了；'not-found' = 命中 0 条（不是自己的记录或已不存在）；'fail' = 调用失败
 */
function checkDeleteResult(del) {
  if (!del || !del.result || !del.result.success) return 'fail'
  if ((del.result.removed || 0) <= 0) return 'not-found'
  return 'ok'
}

module.exports = { checkDeleteResult }
