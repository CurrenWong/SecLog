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

      default:
        return { success: false, code: 'UNKNOWN_ACTION', message: `未知 action: ${action}` }
    }
  } catch (err) {
    return { success: false, code: 'SERVER_ERROR', message: err.message, stack: err.stack }
  }
}
