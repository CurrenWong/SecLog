// 秒记 miaojiRecord 云函数
// 负责记账数据的增 / 查 / 删 / 汇总 / ocr / 登录
const cloud = require('wx-server-sdk')
const tcb = require('@cloudbase/node-sdk')

cloud.init({
  env: 'seclog-d1g8no5pc45e643aa',
})

// 服务端 AI 走 @cloudbase/node-sdk（wx-server-sdk 无 cloud.ai()）
// 文档：@cloudbase/node-sdk >= 3.16.0 才有 app.ai() 多模态通道
const tcbApp = tcb.init({ env: 'seclog-d1g8no5pc45e643aa' })

const db = cloud.database()
const _ = db.command
const COLLECTION = 'miaoji_records'

// 小程序端调用时 openid 一定有；非微信上下文直接调用（如测试）时为 undefined。
// 为空时返回全部数据（测试/管理场景），不过滤以免 where({}) 报错。
function ownerQuery() {
  const openid = cloud.getWXContext().OPENID
  return openid ? { openid } : null
}

// —— 拍照记账：调 CloudBase AI（@cloudbase/node-sdk app.ai() 通道）做多模态小票识别 ——
// 用 @cloudbase/node-sdk 的 app.ai()（自动内网鉴权，不需要硬编码 key）。
// 注意：wx-server-sdk 无 cloud.ai()；AI 能力只在 @cloudbase/node-sdk >= 3.16.0 提供。
async function extractFromImage(imageUrl) {
  const prompt = [
    '你是一个小票识别助手。请仔细识别这张消费凭证（小票/发票/支付截图）。',
    '提取以下字段并以 JSON 返回（不要任何额外解释、不要代码块包裹）：',
    '1. amount: 总金额（数字，如 45.5）。若无法确认金额返回 null。',
    '2. merchant: 商家/收款方名称（字符串）。无法识别返回 ""。',
    '3. category: 消费类别，从以下枚举选一个：餐饮、交通、购物、居家、医疗、娱乐、教育、其他。',
    '4. date: 消费日期（YYYY-MM-DD），无法识别返回 ""。',
    '只输出一个 JSON 对象，例如：{"amount":45.5,"merchant":"全家便利店","category":"购物","date":"2026-07-15"}',
  ].join('\n')

  const ai = tcbApp.ai()
  if (!ai) {
    return { success: false, code: 'AI_UNAVAILABLE', message: '云函数 @cloudbase/node-sdk 未初始化 AI 通道' }
  }
  const model = ai.createModel('hunyuan-exp')
  const res = await model.generateText({
    model: 'hunyuan-2.0-instruct-20251111',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
  })

  const content = res && (res.text || (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content))
  if (!content) {
    return { success: false, code: 'AI_EMPTY', message: '模型返回为空' }
  }

  // 容错解析：去掉 ```json ``` 包裹、提取第一个 {..} 块
  let jsonStr = String(content).trim()
  const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) jsonStr = fence[1].trim()
  const brace = jsonStr.match(/\{[\s\S]*\}/)
  if (brace) jsonStr = brace[0]

  let parsed
  try {
    parsed = JSON.parse(jsonStr)
  } catch (e) {
    return { success: false, code: 'AI_PARSE_ERROR', message: '模型返回无法解析为 JSON', raw: String(content).slice(0, 200) }
  }

  const amount = typeof parsed.amount === 'number' ? parsed.amount : null
  const categoryEnum = ['餐饮', '交通', '购物', '居家', '医疗', '娱乐', '教育', '其他']
  const category = categoryEnum.includes(parsed.category) ? parsed.category : '其他'

  return {
    success: true,
    amount,
    merchant: typeof parsed.merchant === 'string' ? parsed.merchant : '',
    category,
    date: typeof parsed.date === 'string' ? parsed.date : '',
  }
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

      // 查询最近 N 笔（支持 days 过滤最近 N 天）
      case 'list': {
        const limit = Math.min(Number(payload && payload.limit) || 10, 200)
        const days = Number(payload && payload.days) || 0
        let query = db.collection(COLLECTION)
        if (owner) query = query.where(owner)
        // days > 0：在 owner 过滤基础上追加 createdAt >= (now - days天)
        if (days > 0) {
          const since = new Date(Date.now() - days * 24 * 3600 * 1000)
          query = query.where({ createdAt: _.gte(since) })
        }
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

        // 本月真实逐笔记录（供前端拼明细，避免模型编造）
        const records = rows
          .map((r) => ({
            _id: r._id,
            amount: r.amount,
            type: r.type || (r.amount < 0 ? 'expense' : 'income'),
            category: r.category || '其他',
            note: r.note || '',
            createdAt: r.createdAt,
          }))
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) // 新→旧

        return {
          success: true,
          month: month && month !== 'this' ? month : 'this',
          expenseTotal,
          incomeTotal,
          net: incomeTotal + expenseTotal, // 支出为负，收入为正 → 净 = 收入 + 支出
          count: rows.length,
          byCategory: categories,
          records,
        }
      }

      // 拍照记账：识别小票图片 → 返回结构化字段
      // payload: { imageUrl: 临时图片 URL 或云存储 fileID }
      case 'ocr': {
        const { imageUrl } = payload || {}
        if (!imageUrl) {
          return { success: false, code: 'MISSING_IMAGE', message: '缺少 imageUrl' }
        }
        // fileID 需换临时访问 URL（云存储临时链接有效期短，云函数内同步用）
        let realUrl = imageUrl
        if (imageUrl.startsWith('cloud://') || imageUrl.startsWith('wxfile://')) {
          try {
            const tmp = await cloud.getTempFileURL({ fileList: [imageUrl] })
            if (tmp.fileList && tmp.fileList[0] && tmp.fileList[0].tempFileURL) {
              realUrl = tmp.fileList[0].tempFileURL
            }
          } catch (e) {
            return { success: false, code: 'URL_RESOLVE_ERROR', message: e.message }
          }
        }
        const result = await extractFromImage(realUrl)
        if (!result.success) return result
        return {
          success: true,
          amount: result.amount,
          merchant: result.merchant,
          category: result.category,
          date: result.date,
        }
      }

      // 登录：返回 openid / unionid，并 upsert 用户档案（首次记录注册时间）
      // 头像昵称由前端选择后通过 updateProfile 写入，这里只管身份。
      case 'login': {
        const ctx = cloud.getWXContext()
        const openid = ctx.OPENID
        const unionid = ctx.UNIONID || null
        if (!openid) {
          return { success: false, code: 'NO_OPENID', message: '非微信上下文无法登录' }
        }
        const users = db.collection('users')
        const exist = await users.where({ openid }).get()
        if (exist.data && exist.data.length) {
          // 已注册：若 unionid 之前为空且本次有，补存
          const u = exist.data[0]
          if (!u.unionid && unionid) {
            await users.doc(u._id).update({ data: { unionid } })
          }
          return {
            success: true,
            openid,
            unionid: u.unionid || unionid,
            registeredAt: u.registeredAt,
            avatarUrl: u.avatarUrl || '',
            nickName: u.nickName || '',
            isNew: false,
          }
        }
        // 首次注册
        const reg = {
          openid,
          unionid,
          avatarUrl: '',
          nickName: '',
          registeredAt: db.serverDate(),
        }
        await users.add({ data: reg })
        return {
          success: true,
          openid,
          unionid,
          registeredAt: reg.registeredAt,
          avatarUrl: '',
          nickName: '',
          isNew: true,
        }
      }

      // 更新用户资料（头像 / 昵称），由前端授权后调用
      case 'updateProfile': {
        const ctx = cloud.getWXContext()
        const openid = ctx.OPENID
        if (!openid) {
          return { success: false, code: 'NO_OPENID', message: '非微信上下文' }
        }
        const { avatarUrl, nickName } = payload || {}
        const patch = {}
        if (typeof avatarUrl === 'string') patch.avatarUrl = avatarUrl
        if (typeof nickName === 'string') patch.nickName = nickName
        console.log('[updateProfile] openid=', openid, 'patch=', JSON.stringify(patch))
        if (!Object.keys(patch).length) {
          return { success: false, code: 'NOTHING', message: '没有要更新的字段' }
        }
        const users = db.collection('users')
        const exist = await users.where({ openid }).get()
        if (exist.data && exist.data.length) {
          await users.doc(exist.data[0]._id).update({ data: patch })
        } else {
          await users.add({ data: Object.assign({ openid, unionid: ctx.UNIONID || null }, patch) })
        }
        return { success: true, patch }
      }

      default:
        return { success: false, code: 'UNKNOWN_ACTION', message: `未知 action: ${action}` }
    }
  } catch (err) {
    return { success: false, code: 'SERVER_ERROR', message: err.message, stack: err.stack }
  }
}
