// 秒记 miaojiRecord 云函数
// 负责记账数据的增 / 查 / 删 / 汇总 / ocr / 登录
const cloud = require('wx-server-sdk')

cloud.init({
  env: 'seclog-d1g8no5pc45e643aa',
})

const db = cloud.database()
const _ = db.command
const COLLECTION = 'miaoji_records'
const { parseOcrResponse } = require('./parseOcr')

// 金额四舍五入保留两位小数（消除 JS 浮点累加误差，如 76.8 + 74.47 = 151.26999999999998）
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

// 小程序端调用时 openid 一定有；非微信上下文直接调用（如测试）时为 undefined。
// 为空时返回全部数据（测试/管理场景），不过滤以免 where({}) 报错。
function ownerQuery() {
  const openid = cloud.getWXContext().OPENID
  return openid ? { openid } : null
}

// —— 图片引用 → 模型可用的 base64 data-URL ——
// 调用方只传引用（cloud:// fileID 或 https:// URL），函数内部 fetch + 转 base64。
// 这样 base64 不走调用链路（避免 401KB 原图 base64 字符串塞进 params 触发工具 / 网关限制）。
// data:image/... 直传仅保留作为调试入口（前端 / 本地测试可直接贴 base64，生产别用）。
async function fetchAsBase64DataUrl(ref) {
  if (typeof ref !== 'string' || !ref) throw new Error('imageUrl 不能为空')

  // 1) base64 data-URL：调试用，原样返回
  if (ref.startsWith('data:image')) return ref

  // 2) cloud:// / wxfile://：先换临时 https URL，再 fetch 转 base64
  let httpsUrl = ref
  if (ref.startsWith('cloud://') || ref.startsWith('wxfile://')) {
    const tmp = await cloud.getTempFileURL({ fileList: [ref] })
    if (!tmp.fileList || !tmp.fileList[0] || !tmp.fileList[0].tempFileURL) {
      throw new Error('云存储 fileID 解析为临时 URL 失败')
    }
    httpsUrl = tmp.fileList[0].tempFileURL
  }

  // 3) https URL：fetch 二进制 + 转 base64
  if (!/^https?:\/\//i.test(httpsUrl)) {
    throw new Error(`imageUrl 协议不支持（需 cloud:// / https:// / data:image/）：${ref.slice(0, 80)}`)
  }
  const resp = await fetch(httpsUrl, { method: 'GET' })
  if (!resp.ok) throw new Error(`fetch 图片失败 HTTP ${resp.status}`)
  const ab = await resp.arrayBuffer()
  const buf = Buffer.from(ab)
  // content-type 探测：响应头 → 文件头 → 默认 jpeg
  let ct = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!ct || !ct.startsWith('image/')) {
    if (buf[0] === 0xff && buf[1] === 0xd8) ct = 'image/jpeg'
    else if (buf[0] === 0x89 && buf[1] === 0x50) ct = 'image/png'
    else if (buf[0] === 0x47 && buf[1] === 0x49) ct = 'image/gif'
    else if (buf[0] === 0x52 && buf[1] === 0x49) ct = 'image/webp'
    else ct = 'image/jpeg'
  }
  // 限流：超过 4MB 不让模型处理（401KB 原图已经是上限了）
  if (buf.length > 4 * 1024 * 1024) {
    throw new Error(`图片过大 ${(buf.length / 1024 / 1024).toFixed(2)}MB（>4MB），请压缩后再上传`)
  }
  return `data:${ct};base64,${buf.toString('base64')}`
}

// —— 拍照记账：调 CloudBase AI（@cloudbase/node-sdk app.ai() 通道）做多模态小票识别 ——
// 用 @cloudbase/node-sdk 的 app.ai()（自动内网鉴权，不需要硬编码 key）。
// 注意：wx-server-sdk 无 cloud.ai()；AI 能力只在 @cloudbase/node-sdk >= 3.16.0 提供。
async function extractFromImage(imageRef) {
  const prompt = [
    '你是一个消费凭证识别助手。识别用户上传的消费图片（小票/发票/支付宝/微信账单详情页/银行 APP 交易截图等），提取记账需要的字段。',
    '',
    '⚠️ 关键识别规则（按重要性排序）：',
    '1. 金额（amount）：页面里【最大、最显眼、居中显示的数字】，通常带 ¥ 符号或负号（-）。',
    '   - 忽略：时间里的数字（如 20:01:23）、订单号/交易号、积分（5积分）、抵扣券金额（0.5元话费券）、状态文字（交易成功）。',
    '   - 若是支付宝/微信 APP 的「账单详情」界面，金额就是顶部大字号、带「-」号的数字（如 -76.80 → 76.80）。',
    '   - 若是小票/发票，找「合计/应付/总计/实付/金额」旁边的数字，不要拿「单价/数量」。',
    '2. 商家（merchant）：从「商品说明」「收款方」「商户名称」「商家」等标签旁的字段提取，',
    '   - 不要拿界面顶部的页面标题（如「账单详情」「交易记录」）。',
    '   - 若是小票，取抬头店名。',
    '   - 若是支付宝详情，取「商品说明」字段（如「蜘蛛侠：薪新之日保利国际影城上海唐镇店」可取「保利国际影城上海唐镇店」或保留完整）。',
    '3. 类别（category）：从以下枚举选最接近的一个：餐饮、交通、购物、居家、医疗、娱乐、教育、其他。',
    '   - 电影院/演唱会/景点/游戏 → 娱乐',
    '   - 餐饮店/外卖/咖啡 → 餐饮',
    '   - 加油站/打车/公交 → 交通',
    '   - 若 APP 自带分类（如「文化休闲」「美食」），以其为参考但不绝对。',
    '4. 日期（date）：优先用「支付时间/交易时间/消费时间」字段（YYYY-MM-DD）。',
    '   - 不要用界面顶部的手机状态栏时间（20:10）。',
    '   - 无法识别时返回 ""。',
    '',
    '以 JSON 返回（不要任何额外解释、不要代码块包裹）：',
    '1. amount: 总金额（数字，如 45.5）。若无法确认金额返回 null。',
    '2. merchant: 商家/收款方名称（字符串）。无法识别返回 ""。',
    '3. category: 消费类别，从枚举选一个（餐饮/交通/购物/居家/医疗/娱乐/教育/其他）。',
    '4. date: 消费日期（YYYY-MM-DD），无法识别返回 ""。',
    '只输出一个 JSON 对象，例如：{"amount":45.5,"merchant":"全家便利店","category":"购物","date":"2026-07-15"}',
  ].join('\n')

  // 1) 把图片引用转 base64（cloud:// → getTempFileURL → fetch → base64）
  let dataUrl
  try {
    dataUrl = await fetchAsBase64DataUrl(imageRef)
  } catch (e) {
    return {
      success: false,
      code: 'IMAGE_FETCH_ERROR',
      message: String(e && e.message || e).slice(0, 500),
    }
  }

  // ⚠️ 视觉 OCR 模型：DeepSeek（OpenAI 兼容 HTTP API，2026-10-01 切换，弃用 cloudbase 组）
  // - API Key 从环境变量 DEEPSEEK_API_KEY 读取（由云函数环境变量注入，绝不硬编码进代码）
  // - 模型名默认 deepseek-chat（多模态视觉版），可用环境变量 DEEPSEEK_MODEL 覆盖
  // - hunyuan-2.0-instruct(=hy3) 纯文本模型，传图被忽略 → 幻觉错值（历史教训，绝不用）
  // content 顺序：image 在前、text 在后（推荐写法，避免模型把 text 当主任务图当附件忽略）
  const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
  const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  if (!DEEPSEEK_API_KEY) {
    return { success: false, code: 'AI_UNAVAILABLE', message: '未配置 DEEPSEEK_API_KEY 环境变量' }
  }
  let res
  let lastErr
  // 云端 API 偶发 5xx/429，加重试覆盖（指数退避，最多 3 次）
  const MAX_RETRY = 3
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const httpResp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: dataUrl } },
                { type: 'text', text: prompt },
              ],
            },
          ],
        }),
      })
      if (!httpResp.ok) {
        const errBody = await httpResp.text()
        throw Object.assign(new Error(`DeepSeek HTTP ${httpResp.status}: ${errBody.slice(0, 300)}`), {
          status: httpResp.status,
        })
      }
      res = await httpResp.json()
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      // 仅对 400/403/429 等可重试错误重试，参数错误（其他 4xx）直接抛
      const status = e && e.status
      const isRetryable = !status || [400, 403, 429, 500, 502, 503].includes(status)
      if (!isRetryable || attempt === MAX_RETRY) {
        return {
          success: false,
          code: 'AI_CALL_ERROR',
          message: String(e && e.message || e).slice(0, 500),
          stack: String(e && e.stack || '').slice(0, 500),
          status,
          attempt,
          responseBody: e && e.response && e.response.body ? String(e.response.body).slice(0, 500) : undefined,
        }
      }
      // 退避：400ms / 800ms
      await new Promise((r) => setTimeout(r, 400 * attempt))
    }
  }
  if (lastErr) {
    return {
      success: false,
      code: 'AI_CALL_ERROR',
      message: String(lastErr && lastErr.message || lastErr).slice(0, 500),
    }
  }

  const content = res && (res.text || (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content))
  if (!content) {
    return { success: false, code: 'AI_EMPTY', message: '模型返回为空' }
  }

  // 容错解析 + 字段归一化（详见 ./parseOcr.js，单测覆盖）
  const parsed2 = parseOcrResponse(content)
  if (!parsed2.ok) {
    return { success: false, code: parsed2.code, message: parsed2.message, raw: parsed2.raw }
  }

  return {
    success: true,
    amount: round2(parsed2.amount),
    merchant: parsed2.merchant,
    category: parsed2.category,
    date: parsed2.date,
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
          amount: round2(Number(amount)),
          type: type || (amount < 0 ? 'expense' : 'income'), // expense 支出 / income 收入
          category: category || '其他',
          note: note || '',
          createdAt: db.serverDate(),
        }
        const res = await db.collection(COLLECTION).add({ data: record })
        return { success: true, _id: res._id, record }
      }

      // 查询最近 N 笔（支持 days / month / startDate+endDate 过滤）
      case 'list': {
        const limit = Math.min(Number(payload && payload.limit) || 10, 200)
        const days = Number(payload && payload.days) || 0
        const month = payload && payload.month
        const startDate = payload && payload.startDate
        const endDate = payload && payload.endDate
        // 北京时间偏移（与 stats 口径一致）：所有"月/日"边界按北京时间解释再换算 UTC
        const TZ_OFFSET = 8 * 60 * 60 * 1000
        // 把"北京时间的 y-m-d HH:MM:SS"解释为 UTC 毫秒（endOfDay=true → 当天 23:59:59.999）
        const toUtcMidnight = (y, m, d, endOfDay) => {
          const base = Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0)
          return new Date(base - TZ_OFFSET) // 北京时间 0 点 = UTC 前一天 16:00
        }
        // ⚠️ CloudBase 文档库多个 .where() 链式调用是【覆盖】关系，必须把多个字段合并到单个对象里
        // 之前 `query.where(owner)` 然后 `query.where({ createdAt: ... })` 会让 owner 被 createdAt 覆盖
        // 后果：days > 0 时 owner 过滤丢失，返回了【所有用户】的记录，导致前端看到「别人」的数据，且
        // 用户按 _id 删自己的记录时，那些「别人的」记录无法被命中删除（owner 不匹配），
        // 但前端 toast 显示「已删除」造成误导。
        // 修复：把所有筛选条件塞进单个 where({...})，多字段间由 SDK 自动 AND。
        const cond = {}
        if (owner) cond.openid = owner.openid
        if (startDate && endDate) {
          // 任意时间段：北京时间当天 0 点起 → 含当天 23:59:59.999
          const [sy, sm, sd] = startDate.split('-').map(Number)
          const [ey, em, ed] = endDate.split('-').map(Number)
          const start = toUtcMidnight(sy, sm, sd, false)
          const end = toUtcMidnight(ey, em, ed, true)
          cond.createdAt = _.gte(start).and(_.lt(end))
        } else if (month && month !== 'this') {
          // month 格式 'YYYY-MM'
          const [y, m] = month.split('-').map(Number)
          const start = toUtcMidnight(y, m, 1, false)
          const end = toUtcMidnight(y, m + 1, 1, false)
          cond.createdAt = _.gte(start).and(_.lt(end))
        } else if (month === 'this') {
          // 本月：北京时间本月 1 号 0 点起（无上限，含今天）
          const nowBJ = new Date(Date.now() + TZ_OFFSET)
          const start = toUtcMidnight(nowBJ.getUTCFullYear(), nowBJ.getUTCMonth() + 1, 1, false)
          cond.createdAt = _.gte(start)
        } else if (days > 0) {
          // 兜底：最近 N 天滚动窗口（仅在没有更精确的 month/startDate 时使用）
          const since = new Date(Date.now() - days * 24 * 3600 * 1000)
          cond.createdAt = _.gte(since)
        }
        const res = await db.collection(COLLECTION)
          .where(cond)
          .orderBy('createdAt', 'desc')
          .limit(limit)
          .get()
        // 每条金额 round2，避免前端拿到浮点长尾（如 74.47 本身干净，但保险起见统一处理）
        const list = res.data.map((r) => Object.assign({}, r, { amount: round2(r.amount) }))
        return { success: true, list, total: list.length }
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

      // 一次性数据迁移：把 owner = 'anonymous' 的字面值记录改成调用方 openid
      // 安全约束：只迁字面字符串 'anonymous'，缺 openid 字段或其他 openid 一概不动
      case 'migrateAnonymous': {
        const openid = cloud.getWXContext().OPENID
        if (!openid) {
          return { success: false, code: 'NO_OPENID', message: '非微信上下文无法迁移' }
        }
        const res = await db.collection(COLLECTION)
          .where({ openid: 'anonymous' })
          .update({ data: { openid } })
        return {
          success: true,
          migrated: res.stats.updated,
          toOpenid: openid,
          note: '字面值 anonymous 才迁；缺字段或其他 openid 不动',
        }
      }

      // 汇总（今日 / 本月）
      case 'summary': {
        // 记账用户在中国时区（UTC+8）。日期边界按北京时间算，否则 7 月底北京时间的数据
        // 在 UTC 下属于 7 月，会被 _.gte(UTC 8月1日) 整批漏掉 → 本月支出显示 0。
        const TZ_OFFSET = 8 * 60 * 60 * 1000
        const now = new Date(Date.now() + TZ_OFFSET) // 转成"北京时间"视角
        const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0) - TZ_OFFSET)
        const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0) - TZ_OFFSET)

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
            if (r.type === 'income') acc.income = round2(acc.income + r.amount)
            else acc.expense = round2(acc.expense + r.amount)
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

      // 统计：按分类汇总（支持指定月份 / 任意时间段，默认本月）
      // payload:
      //   month?: '2026-07' | 'this' | 不传(本月)
      //   startDate?, endDate?: 'YYYY-MM-DD' 任意区间（优先于 month；endDate 含当天 23:59:59）
      //   category?: 指定分类
      case 'stats': {
        const { month, category, startDate, endDate } = payload || {}
        // 确定统计起止时间
        // 记账用户在中国时区（UTC+8）。所有"日/月"边界按北京时间解释，再换算成对应的 UTC 毫秒，
        // 与数据库 serverDate() 存的 UTC 时间比较。避免 7 月底北京时间的数据在 UTC 下漏统计。
        const TZ_OFFSET = 8 * 60 * 60 * 1000 // 北京时间相对 UTC 的毫秒偏移
        let start, end
        let useLt = false // 是否加 _.lt(end) 上限
        // 把"北京时间的 y-m-d HH:MM:SS"解释为 UTC 毫秒。endOfDay=true → 当天 23:59:59.999
        const toUtcMidnight = (y, m, d, endOfDay) => {
          const base = Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0)
          return new Date(base - TZ_OFFSET) // 减去偏移：北京时间 0 点 = UTC 前一天 16:00
        }
        if (startDate && endDate) {
          // 任意时间段：startDate 当天 0 点 UTC 起，endDate 含当天 23:59:59.999 UTC
          const [sy, sm, sd] = startDate.split('-').map(Number)
          const [ey, em, ed] = endDate.split('-').map(Number)
          start = toUtcMidnight(sy, sm, sd, false)
          end = toUtcMidnight(ey, em, ed, true)
          useLt = true
        } else if (month && month !== 'this') {
          // month 格式 'YYYY-MM'
          const [y, m] = month.split('-').map(Number)
          start = toUtcMidnight(y, m, 1, false)
          end = toUtcMidnight(y, m + 1, 1, false) // 下月 1 号 0 点 UTC（不含）
          useLt = true
        } else {
          // 本月：按北京时间视角的年月算（toUtcMidnight 会把入参当北京时间解释）
          const nowBJ = new Date(Date.now() + TZ_OFFSET) // 北京时间视角
          start = toUtcMidnight(nowBJ.getUTCFullYear(), nowBJ.getUTCMonth() + 1, 1, false)
        }

        // 注意：CloudBase 文档库多次 .where() 是覆盖关系，不能链式加 _.lt(end)。
        // 必须在同一字段上用 command.and() 合并范围条件。
        const createdAtCond = useLt ? _.gte(start).and(_.lt(end)) : _.gte(start)
        const cond = { createdAt: createdAtCond }
        if (owner) cond.openid = owner.openid
        const q = db.collection(COLLECTION).where(cond)
        const res = await q.get()

        const rows = res.data
        // 按分类聚合（只算支出 expense）
        const byCategory = {}
        let expenseTotal = 0
        let incomeTotal = 0
        for (const r of rows) {
          if (r.type === 'income') {
            incomeTotal = round2(incomeTotal + r.amount)
          } else {
            expenseTotal = round2(expenseTotal + r.amount)
            const cat = r.category || '其他'
            byCategory[cat] = round2((byCategory[cat] || 0) + r.amount)
          }
        }

        // 若指定了分类，只返回该分类
        if (category) {
          const val = byCategory[category] || 0
          return {
            success: true,
            month: month && month !== 'this' ? month : 'this',
            rangeLabel: (startDate && endDate) ? `${startDate} ~ ${endDate}` : '',
            category,
            amount: val,
            count: rows.filter((r) => (r.category || '其他') === category && r.type !== 'income').length,
          }
        }

        // 分类排序（绝对值从大到小）
        const categories = Object.keys(byCategory)
          .map((c) => ({ category: c, amount: round2(byCategory[c]) }))
          .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))

        // 本月真实逐笔记录（供前端拼明细，避免模型编造）
        const records = rows
          .map((r) => ({
            _id: r._id,
            amount: round2(r.amount),
            type: r.type || (r.amount < 0 ? 'expense' : 'income'),
            category: r.category || '其他',
            note: r.note || '',
            createdAt: r.createdAt,
          }))
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) // 新→旧

        return {
          success: true,
          month: month && month !== 'this' ? month : 'this',
          rangeLabel: (startDate && endDate) ? `${startDate} ~ ${endDate}` : '',
          expenseTotal,
          incomeTotal,
          net: round2(incomeTotal + expenseTotal), // 支出为负，收入为正 → 净 = 收入 + 支出
          count: rows.length,
          byCategory: categories,
          records,
        }
      }

      // 拍照记账：识别小票图片 → 返回结构化字段
      // payload: { imageUrl: 云存储 fileID (cloud://...) 或 https:// URL }
      // ⚠️ 不再接受 base64 data-URL 作为生产入参（base64 走调用链路太长）。
      //    base64 转换统一在 fetchAsBase64DataUrl() 内完成，调用方只传引用。
      case 'ocr': {
        const { imageUrl } = payload || {}
        if (!imageUrl) {
          return { success: false, code: 'MISSING_IMAGE', message: '缺少 imageUrl' }
        }
        const result = await extractFromImage(imageUrl)
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
