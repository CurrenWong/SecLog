// utils/extractByModel.js
// 统一意图路由器：让大模型先做意图判断（record / query / undo / chat），
// 正则只做"线索抽取"喂给模型，最终 decision 权在模型。
//
// 设计原则（Curren 2026-07-14 确认）：
//   - 模型是第一个处理器，对所有输入返回结构化意图 JSON
//   - 模型在一轮里只输出意图 JSON，绝不输出给用户看的散文
//   - 用户看到的每句话都是代码按 action 生成的确定性文本
//
// callModel(prompt) => Promise<string>  返回模型原始文本（可能含 markdown / 多余话术）
//
// 返回统一结构：
//   { action: 'record', amount, category, note }           → 记一笔新账
//   { action: 'correct', amount, category, note, target }  → 更正最近一笔
//   { action: 'query',  query: { type, category, month } } → 查库回答（模板，不幻觉）
//   { action: 'undo' }                                     → 撤回最近一笔
//   { action: 'chat' }                                     → 闲聊，放行模型自由对话
//   null                                                   → 模型调用失败 / 无法解析（保守降级）

// 与 parseExpense 保持一致的分类白名单，校验模型输出合法性
const VALID_CATEGORIES = new Set([
  '餐饮', '交通', '购物', '居家', '娱乐', '医疗', '教育', '收入', '其他',
])

// 金额合理范围（防止模型抽飞，如 38000000）
const MAX_ABS_AMOUNT = 1e7

// 查询类型白名单
const VALID_QUERY_TYPES = new Set(['month', 'day', 'category', 'recent', 'breakdown', 'income', 'range'])

// 从模型文本中抠出第一个 JSON 对象（兼容 ```json 代码块 或裸 JSON）
function extractJson(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i)
  let jsonStr = null
  if (fenced) {
    jsonStr = fenced[1]
  } else {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    jsonStr = (start !== -1 && end !== -1 && end > start) ? text.slice(start, end + 1) : null
  }
  if (!jsonStr) return null
  try {
    return JSON.parse(jsonStr)
  } catch (e) {
    return null
  }
}

// 金额归一：positive=收入 / 负数或 type=expense=支出
function normalizeAmount(amount, type) {
  const a = Number(amount)
  if (!Number.isFinite(a) || a === 0) return null
  if (Math.abs(a) > MAX_ABS_AMOUNT) return null
  if (type === 'income') return Math.abs(a)
  if (type === 'expense') return -Math.abs(a)
  return a // 模型直接给带符号数字
}

// 校验并归一化一条记账记录
// 返回：{ amount, category, note } 正常；{ amount: null } 表示被动填槽（模型主动 amount:null，如"记一笔"无金额）；null 表示完全无效（退化 chat）
function validateRecord(parsed) {
  // 模型主动 amount:null（或字段缺失但明确是记账意图）→ 被动填槽，保留 record 让上层追问
  if (parsed.amount === null || parsed.amount === undefined) {
    const category = VALID_CATEGORIES.has(parsed.category) ? parsed.category : '其他'
    const note = typeof parsed.note === 'string' ? parsed.note.slice(0, 20) : ''
    return { amount: null, category, note }
  }
  const amount = normalizeAmount(parsed.amount, parsed.type)
  if (amount === null) return null // 金额无效（乱码/0/超范围）→ 退化 chat
  const category = VALID_CATEGORIES.has(parsed.category) ? parsed.category : '其他'
  const note = typeof parsed.note === 'string' ? parsed.note.slice(0, 20) : ''
  return { amount, category, note }
}

// 构造意图分类 prompt
// 正则线索（parseExpense / parseQuery / parseUndo 的结果）作为上下文喂给模型，
// 帮助它判断意图，但最终 decision 权在模型（正则可能漏抽或误抽）。
function buildPrompt(text, hints = {}) {
  const { regexExpense = null, regexExpenses = null, queryHint = null, undoHint = false, recentRecord = null, context = null, history = null, distantSummary = null } = hints
  const lines = [
    '你是秒记记账助手的意图理解器。分析用户这句话的意图，输出一个 JSON 对象，不要任何解释、不要 markdown 代码块标记、不要多余文字。',
    '',
    '字段说明：',
    '- action: 必填，四选一：',
    '    "record" = 用户说出/暗示一笔消费或收入（要记账）',
    '    "multi_record" = 用户一句话里说了【两笔或更多】独立的消费或收入（如"午饭38打车25买菜60""早饭12，午饭38，晚饭45"），要一次性记多笔',
    '    "query"  = 用户想看汇总/分类/明细/某天花了多少（统计查询，不要当记账）',
    '    "undo"   = 用户要撤回/删除刚才记的那笔（"记错了/撤回/删掉/取消记录"）',
    '    "chat"   = 闲聊、普通提问、与记账和查询都无关',
    '- 当 action="record" 时附带：',
    '    amount(数字，支出负数/收入正数), category(餐饮/交通/购物/居家/娱乐/医疗/教育/收入/其他), note(≤20字备注)',
    '- 当 action="multi_record" 时附带：',
    '    records: [ { amount, category, note }, ... ]  （每笔格式同 record，逐条独立；注意每笔的支出/收入符号要正确）',
    '- 当 action="query" 时附带：',
    '    query: { type: "month"|"day"|"category"|"recent"|"breakdown"|"range", category?: "餐饮"等（仅 type=category 时需要）, range?: {...}（仅 type=range 时需要） }',
    '    type 说明：',
    '      "month"  = 这个月总共花了多少（总览）',
    '      "day"    = 今天花了多少',
    '      "category" = 指定某个【消费】分类花了多少（必须带 category，如"餐饮花了多少"→category:"餐饮"）',
    '      "breakdown" = 按分类统计支出（列出所有分类各自花了多少，如"按分类统计/各类花了多少/分类汇总"，不带具体分类名）',
    '      "income" = 问收入汇总（如"收入有多少""赚了多少""这个月入账多少"）→ 注意：不要判成 category:"收入"，收入是汇总维度不是消费分类',
    '      "recent" = 最近记了几笔（明细），可附 only:"income" 只看收入 / only:"expense" 只看支出（如"收入明细"→recent+only:"income"）',
    '      "range"  = 任意时间段查询（非本月/今日/指定单月），需带 range 对象，三选一：',
    '          range: { mode: "year", year: 2026 }            → 某一年（"今年""去年""2025年"）',
    '          range: { mode: "lastN", days: 30 }             → 最近 N 天（"最近30天""近一周"→days:7）',
    '          range: { mode: "between", from: "2026-01-01", to: "2026-06-30" }  → 起止日期区间（"1月到6月""从元旦到国庆"）',
    '        range 模式默认看支出+收入总览（同 month 模板），不指定分类。',
    '- 当 action="undo" 或 "chat" 时，不带其他字段。',
    '',
    '判断规则：',
    '1) 用户明确说出一笔消费或收入，或暗示（如"中午火锅大概五十"）→ action:"record"。',
    '1.5) 用户一句话里含【两笔或更多】独立消费/收入（用顿号/逗号/空格分隔，或连写无分隔如"午饭38打车25"），即便金额都在一句里 → action:"multi_record"，records 为每笔独立对象（不要合并成一笔，也不要只抽第一笔）。',
    '2) 用户问花了多少/这个月开销/某分类花了多少/最近记了啥 → action:"query"。',
    '3) 用户要撤回/删除刚才的记录 → action:"undo"。',
    '4) 闲聊、普通提问、或完全无关 → action:"chat"。',
    '注意：含具体金额（如"午饭38块"）通常是 record；问"花了多少"即使带分类词也是 query，不是 record。',
    '区分"category"与"breakdown"：用户点名了某个具体分类（"餐饮花了多少""交通呢"）→ type:"category" 且带 category:"餐饮"；',
    '用户要的是全部分类分布（"按分类统计支出""各类花了多少""分类汇总一下""支出结构"）→ type:"breakdown"（不带 category）。',
    '区分"income"与"category:收入"：用户问收入汇总（"收入有多少""赚了多少""进账多少"）→ type:"income"（不带 category）；',
    '绝不要把"收入"当成消费分类去查 category:"收入"（收入记录 type=income，不在消费分类统计里）。"支出有多少"仍用 type:"month"（总览含支出）。',
    '"收入明细/支出明细" → type:"recent" 且 only:"income"/"expense"（只看某一类明细，不要混全量）。',
    '区分"range"与"month"：用户问的是跨月/跨年/非当前月的区间（"今年花了多少""去年开销""最近30天""上半年""1月到6月"）→ type:"range" 带对应 range 对象；',
    '用户问的就是当前这个自然月（"这个月/本月"）→ 仍用 type:"month"。"上半年"="1月到6月"→range{between,from:今年-01-01,to:今年-06-30}；"今年"→range{year:今年}；"去年"→range{year:去年}。',
    '',
    '被动填槽（多轮记账）：若用户说"记一笔/记一下/记个账"等记账意图但【没有金额】，',
    '返回 action:"record" 且 amount:null（不要当成 chat，也不要瞎猜金额）。下一轮用户补"38 餐饮"时，',
    '结合下方【对话历史】里的"记一笔"意图，合成完整 record（amount:-38, category:"餐饮"）。',
    '',
  ]

  if (regexExpense) {
    lines.push(`正则消费抽取线索（仅供参考）：${JSON.stringify(regexExpense)}`)
  }
  if (regexExpenses && Array.isArray(regexExpenses) && regexExpenses.length >= 2) {
    lines.push(`正则多笔抽取线索（仅供参考，最终是否多笔由你判断）：${JSON.stringify(regexExpenses)}`)
  }
  if (queryHint) {
    lines.push(`正则查询线索（仅供参考）：${JSON.stringify(queryHint)}`)
  }
  if (undoHint) {
    lines.push('正则命中撤回词（仅供参考）：用户可能想撤回')
  }
  if (recentRecord) {
    lines.push(`最近一笔记账（用于判断 undo/correct）：${JSON.stringify(recentRecord)}`)
  }
  if (context) {
    lines.push('')
    lines.push('【上一轮对话上下文】（仅当前会话有效，用于消解指代/追问）：')
    lines.push(JSON.stringify(context))
    lines.push('指代消解规则：')
    lines.push('- 用户说"明细/具体呢/展开"等 → 延续上一轮的 query.type（如上一轮是 income，则仍 income 但带明细）')
    lines.push('- 用户说"那支出呢/支出多少" → 切到 type:"month"（同一时间段看支出总览）')
    lines.push('- 用户说"X月呢/上个月/上月" → 沿用上一轮 query.type，仅把 month 换成对应月份（如"6月呢"→month:"2026-06"）')
    lines.push('- 用户说"它/这笔/那个/删掉" → 结合上下文指代上一轮提到的记录或分类')
    lines.push('- 若本轮已含明确新意图（如"午饭38块"），以本轮为主，上下文仅辅助')
  }

  // 对话历史（滑动窗口最近 10 轮原始对话）：全量指代消解 + 被动填槽补全
  if (history && history.length) {
    lines.push('')
    lines.push('【对话历史】（最近若干轮原始对话，含当前轮之前的 user/assistant。用于全量指代消解与多轮记账补全）：')
    history.forEach((h, i) => {
      const role = h.role === 'user' ? '用户' : '助手'
      lines.push(`${i + 1}. ${role}：${h.text}`)
    })
    lines.push('基于历史理解指代：')
    lines.push('- "那笔/这个/它"等指代 → 结合历史里最近的相同或相关记录')
    lines.push('- 多轮记账：历史有"记一笔"且当前轮补"38 餐饮" → 合成完整 record（amount:-38, category:"餐饮"）')
    lines.push('- 若本轮已含完整意图（如"午饭38块"），忽略历史，以本轮为主')
  }
  if (distantSummary) {
    lines.push('')
    lines.push('【更早对话摘要】（超出滑动窗口的远处上下文，仅供参考）：')
    lines.push(distantSummary)
  }

  lines.push('')
  lines.push('示例：')
  lines.push('输入"中午跟同事吃了顿火锅大概五十多" → {"action":"record","amount":-55,"category":"餐饮","note":"火锅"}')
  lines.push('输入"发工资了八百块" → {"action":"record","amount":800,"category":"收入","note":"工资"}')
  lines.push('输入"早饭12，午饭38，晚饭45" → {"action":"multi_record","records":[{"amount":-12,"category":"餐饮","note":"早饭"},{"amount":-38,"category":"餐饮","note":"午饭"},{"amount":-45,"category":"餐饮","note":"晚饭"}]}')
  lines.push('输入"午饭38打车25买菜60" → {"action":"multi_record","records":[{"amount":-38,"category":"餐饮","note":"午饭"},{"amount":-25,"category":"交通","note":"打车"},{"amount":-60,"category":"居家","note":"买菜"}]}')
  lines.push('输入"这个月花了多少钱" → {"action":"query","query":{"type":"month"}}')
  lines.push('输入"餐饮花了多少" → {"action":"query","query":{"type":"category","category":"餐饮"}}')
  lines.push('输入"记错了" → {"action":"undo"}')
  lines.push('输入"今天天气不错" → {"action":"chat"}')
  lines.push('输入"今年花了多少" → {"action":"query","query":{"type":"range","range":{"mode":"year","year":2026}}}')
  lines.push('输入"最近30天花了多少" → {"action":"query","query":{"type":"range","range":{"mode":"lastN","days":30}}}')
  lines.push('输入"上半年花了多少" → {"action":"query","query":{"type":"range","range":{"mode":"between","from":"2026-01-01","to":"2026-06-30"}}}')
  lines.push('')
  lines.push(`用户输入：${text}`)

  return lines.join('\n')
}

// 主入口：调用模型做意图判断并校验，返回统一结构
// 返回：
//   { action: 'record', amount, category, note }
//   { action: 'multi_record', records: [{ amount, category, note }, ...] }
//   { action: 'correct', amount, category, note, target }
//   { action: 'query',  query: { type, category?, month? } }
//   { action: 'undo' }
//   { action: 'chat' }
//   null  （模型调用失败 / 无法解析 → 保守降级，交给上层决定）
// ctx（可选）：上一轮对话上下文 { query, summary }，用于多轮指代消解（仅当前会话）
// history（可选）：滑动窗口最近 10 轮原始对话 [{role,text}]，全量指代消解 + 被动填槽补全
// distantSummary（可选）：超出窗口的远处摘要
async function classifyIntent(text, callModel, opts = {}) {
  if (!text || typeof callModel !== 'function') return null
  const { regexExpense = null, regexExpenses = null, queryHint = null, undoHint = false, recentRecord = null, ctx = null, history = null, distantSummary = null } = opts
  let raw
  try {
    raw = await callModel(buildPrompt(text, { regexExpense, regexExpenses, queryHint, undoHint, recentRecord, context: ctx, history, distantSummary }))
  } catch (e) {
    return null // 模型调用失败 → 降级，交回上层
  }
  const parsed = extractJson(raw)
  if (!parsed) return null

  const action = parsed.action

  // query
  if (action === 'query') {
    const q = parsed.query || {}
    const type = VALID_QUERY_TYPES.has(q.type) ? q.type : 'month'
    const query = { type }
    if (type === 'category') {
      query.category = VALID_CATEGORIES.has(q.category) ? q.category : '其他'
    }
    if (type === 'recent' && (q.only === 'income' || q.only === 'expense')) {
      query.only = q.only
    }
    // month 类型：携带 month（"2026-06" 或上下文里的 "this"），供 tryQuery 用指定月份查询
    if (type === 'month' && q.month) {
      query.month = q.month
    }
    // range 类型：携带 range 对象（{mode, year?/days?/from?/to?}），供 tryQuery 转成 startDate/endDate
    if (type === 'range' && q.range) {
      query.range = q.range
    }
    return { action: 'query', query }
  }

  // undo
  if (action === 'undo') return { action: 'undo' }

  // chat
  if (action === 'chat') return { action: 'chat' }

  // correct（更正最近一笔）：带 amount，target 默认 last
  if (action === 'correct') {
    const rec = validateRecord(parsed)
    if (!rec) return { action: 'chat' } // 更正但金额无效 → 退化闲聊
    const target = parsed.target === 'last' ? 'last' : (typeof parsed.target === 'string' ? parsed.target : 'last')
    return { action: 'correct', target, ...rec }
  }

  // record（记一笔）
  if (action === 'record') {
    const rec = validateRecord(parsed)
    if (!rec) return { action: 'chat' } // 金额无效 → 退化闲聊
    return { action: 'record', ...rec }
  }

  // multi_record（一句话多笔记账）：records 为数组，逐条校验+归一
  // 至少保留 1 条有效记录才视为合法多笔；全无效 → 退化 chat
  if (action === 'multi_record') {
    const rawList = Array.isArray(parsed.records) ? parsed.records : []
    const records = []
    for (const r of rawList) {
      const rec = validateRecord(r)
      if (rec) records.push(rec)
    }
    if (records.length >= 1) {
      return { action: 'multi_record', records }
    }
    return { action: 'chat' } // 无有效记录 → 退化闲聊
  }

  // 兼容旧格式（无 action 但带 amount）→ 视为 record
  if (parsed.amount !== undefined) {
    const rec = validateRecord(parsed)
    if (!rec) return { action: 'chat' }
    return { action: 'record', ...rec }
  }

  // 兜底
  return { action: 'chat' }
}

module.exports = { classifyIntent, buildPrompt, extractJson, validateRecord, normalizeAmount, VALID_CATEGORIES }
