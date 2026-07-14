// 秒记 miaojiRecord 云函数
// 负责记账数据的增 / 查 / 删 / 汇总
const cloud = require('wx-server-sdk')

cloud.init({
  env: 'seclog-d1g8no5pc45e643aa',
})

const db = cloud.database()
const _ = db.command
const COLLECTION = 'miaoji_records'

// 小程序端调用时 openid 一定有；非微信上下文直接调用（如测试）时为 undefined。
// 为空时返回全部数据（测试/管理场景），不过滤以免 where({}) 报错。
function ownerQuery() {
  const openid = cloud.getWXContext().OPENID
  return openid ? { openid } : null
}

exports.main = async (event, context) => {
  const { action, payload } = event
  const owner = ownerQuery()

  try {
    switch (action) {
      // 新增一笔记账
      case 'add': {
        const { amount, category, note, type } = payload || {}
        if (typeof amount !== 'number' || isNaN(amount)) {
          return { success: false, code: 'INVALID_AMOUNT', message: 'amount 必须是数字' }
        }
        const openid = cloud.getWXContext().OPENID
        const record = {
          openid: openid || 'anonymous',
          amount: Number(amount),
          type: type || (amount < 0 ? 'expense' : 'income'), // expense 支出 / income 收入
          category: category || '其他',
          note: note || '',
          createdAt: db.serverDate(),
        }
        const res = await db.collection(COLLECTION).add({ data: record })
        return { success: true, _id: res._id, record }
      }

      // 查询最近 N 笔
      case 'list': {
        const limit = Math.min(Number(payload && payload.limit) || 10, 50)
        let query = db.collection(COLLECTION)
        if (owner) query = query.where(owner)
        const res = await query
          .orderBy('createdAt', 'desc')
          .limit(limit)
          .get()
        return { success: true, list: res.data, total: res.data.length }
      }

      // 删除一笔
      case 'delete': {
        const { _id } = payload || {}
        if (!_id) {
          return { success: false, code: 'MISSING_ID', message: '缺少 _id' }
        }
        let query = db.collection(COLLECTION).where({ _id })
        if (owner) query = db.collection(COLLECTION).where(Object.assign({ _id }, owner))
        const res = await query.remove()
        return { success: true, removed: res.stats.removed }
      }

      // 更正 / 修改一笔（amount / category / note / type）
      case 'update': {
        const { _id, amount, category, note, type } = payload || {}
        if (!_id) {
          return { success: false, code: 'MISSING_ID', message: '缺少 _id' }
        }
        // 只更新传入的字段，避免整条覆盖
        const set = {}
        if (typeof amount === 'number' && !isNaN(amount)) {
          set.amount = Number(amount)
          set.type = type || (amount < 0 ? 'expense' : 'income')
        }
        if (typeof category === 'string' && category) set.category = category
        if (typeof note === 'string') set.note = note
        if (!Object.keys(set).length) {
          return { success: false, code: 'NOTHING_TO_UPDATE', message: '没有可更新的字段' }
        }
        let query = db.collection(COLLECTION).where({ _id })
        if (owner) query = db.collection(COLLECTION).where(Object.assign({ _id }, owner))
        const res = await query.update({ data: set })
        return { success: true, updated: res.stats.updated, _id }
      }

      // 汇总（今日 / 本月）
      case 'summary': {
        const now = new Date()
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

        const buildQuery = (start) => {
          let q = db.collection(COLLECTION).where({ createdAt: _.gte(start) })
          if (owner) q = db.collection(COLLECTION).where(Object.assign({ createdAt: _.gte(start) }, owner))
          return q
        }

        const [day, month] = await Promise.all([
          buildQuery(startOfDay).get(),
          buildQuery(startOfMonth).get(),
        ])

        const calc = (rows) => rows.data.reduce(
          (acc, r) => {
            if (r.type === 'income') acc.income += r.amount
            else acc.expense += r.amount
            return acc
          },
          { income: 0, expense: 0 }
        )

        return {
          success: true,
          day: calc(day),
          month: calc(month),
        }
      }

      // 统计：按分类汇总（支持指定月份，默认本月）
      // payload: { month?: '2026-07' | 'this' | 不传(本月), category?: 指定分类 }
      case 'stats': {
        const { month, category } = payload || {}
        // 确定统计起止时间
        let start, end
        let useLt = false // 是否加 _.lt(end) 上限（仅指定历史月份时需要）
        if (month && month !== 'this') {
          // month 格式 'YYYY-MM'
          const [y, m] = month.split('-').map(Number)
          start = new Date(y, m - 1, 1)
          end = new Date(y, m, 1) // 下月 1 号 0 点（不含）
          useLt = true
        } else {
          // 本月：与 summary 对齐，只用 _.gte(startOfMonth)，不加 _.lt
          // （避免云端 serverDate 存 UTC、本地构造 end 时区错位导致整月数据被过滤）
          const now = new Date()
          start = new Date(now.getFullYear(), now.getMonth(), 1)
        }

        const cond = { createdAt: _.gte(start) }
        if (owner) cond.openid = owner.openid
        let q = db.collection(COLLECTION).where(cond)
        if (useLt) q = q.where({ createdAt: _.lt(end) })
        const res = await q.get()

        const rows = res.data
        // 按分类聚合（只算支出 expense）
        const byCategory = {}
        let expenseTotal = 0
        let incomeTotal = 0
        for (const r of rows) {
          if (r.type === 'income') {
            incomeTotal += r.amount
          } else {
            expenseTotal += r.amount
            const cat = r.category || '其他'
            byCategory[cat] = (byCategory[cat] || 0) + r.amount
          }
        }

        // 若指定了分类，只返回该分类
        if (category) {
          const val = byCategory[category] || 0
          return {
            success: true,
            month: month && month !== 'this' ? month : 'this',
            category,
            amount: val,
            count: rows.filter((r) => (r.category || '其他') === category && r.type !== 'income').length,
          }
        }

        // 分类排序（绝对值从大到小）
        const categories = Object.keys(byCategory)
          .map((c) => ({ category: c, amount: byCategory[c] }))
          .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))

        return {
          success: true,
          month: month && month !== 'this' ? month : 'this',
          expenseTotal,
          incomeTotal,
          net: incomeTotal + expenseTotal, // 支出为负，收入为正 → 净 = 收入 + 支出
          count: rows.length,
          byCategory: categories,
        }
      }

      default:
        return { success: false, code: 'UNKNOWN_ACTION', message: `未知 action: ${action}` }
    }
  } catch (err) {
    return { success: false, code: 'SERVER_ERROR', message: err.message, stack: err.stack }
  }
}
