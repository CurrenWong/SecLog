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
const VALID_QUERY_TYPES = new Set(['month', 'day', 'category', 'recent'])

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
function validateRecord(parsed) {
  const amount = normalizeAmount(parsed.amount, parsed.type)
  if (amount === null) return null
  const category = VALID_CATEGORIES.has(parsed.category) ? parsed.category : '其他'
  const note = typeof parsed.note === 'string' ? parsed.note.slice(0, 20) : ''
  return { amount, category, note }
}

// 构造意图分类 prompt
// 正则线索（parseExpense / parseQuery / parseUndo 的结果）作为上下文喂给模型，
// 帮助它判断意图，但最终 decision 权在模型（正则可能漏抽或误抽）。
function buildPrompt(text, hints = {}) {
  const { regexExpense = null, queryHint = null, undoHint = false, recentRecord = null } = hints
  const lines = [
    '你是秒记记账助手的意图理解器。分析用户这句话的意图，输出一个 JSON 对象，不要任何解释、不要 markdown 代码块标记、不要多余文字。',
    '',
    '字段说明：',
    '- action: 必填，四选一：',
    '    "record" = 用户说出/暗示一笔消费或收入（要记账）',
    '    "query"  = 用户想看汇总/分类/明细/某天花了多少（统计查询，不要当记账）',
    '    "undo"   = 用户要撤回/删除刚才记的那笔（"记错了/撤回/删掉/取消记录"）',
    '    "chat"   = 闲聊、普通提问、与记账和查询都无关',
    '- 当 action="record" 时附带：',
    '    amount(数字，支出负数/收入正数), category(餐饮/交通/购物/居家/娱乐/医疗/教育/收入/其他), note(≤20字备注)',
    '- 当 action="query" 时附带：',
    '    query: { type: "month"|"day"|"category"|"recent", category?: "餐饮"等（仅 type=category 时需要） }',
    '- 当 action="undo" 或 "chat" 时，不带其他字段。',
    '',
    '判断规则：',
    '1) 用户明确说出一笔消费或收入，或暗示（如"中午火锅大概五十"）→ action:"record"。',
    '2) 用户问花了多少/这个月开销/某分类花了多少/最近记了啥 → action:"query"。',
    '3) 用户要撤回/删除刚才的记录 → action:"undo"。',
    '4) 闲聊、普通提问、或完全无关 → action:"chat"。',
    '注意：含具体金额（如"午饭38块"）通常是 record；问"花了多少"即使带分类词也是 query，不是 record。',
    '',
  ]

  if (regexExpense) {
    lines.push(`正则消费抽取线索（仅供参考）：${JSON.stringify(regexExpense)}`)
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

  lines.push('')
  lines.push('示例：')
  lines.push('输入"中午跟同事吃了顿火锅大概五十多" → {"action":"record","amount":-55,"category":"餐饮","note":"火锅"}')
  lines.push('输入"发工资了八百块" → {"action":"record","amount":800,"category":"收入","note":"工资"}')
  lines.push('输入"这个月花了多少钱" → {"action":"query","query":{"type":"month"}}')
  lines.push('输入"餐饮花了多少" → {"action":"query","query":{"type":"category","category":"餐饮"}}')
  lines.push('输入"记错了" → {"action":"undo"}')
  lines.push('输入"今天天气不错" → {"action":"chat"}')
  lines.push('')
  lines.push(`用户输入：${text}`)

  return lines.join('\n')
}

// 主入口：调用模型做意图判断并校验，返回统一结构
// 返回：
//   { action: 'record', amount, category, note }
//   { action: 'correct', amount, category, note, target }
//   { action: 'query',  query: { type, category?, month? } }
//   { action: 'undo' }
//   { action: 'chat' }
//   null  （模型调用失败 / 无法解析 → 保守降级，交给上层决定）
async function classifyIntent(text, callModel, opts = {}) {
  if (!text || typeof callModel !== 'function') return null
  const { regexExpense = null, queryHint = null, undoHint = false, recentRecord = null } = opts
  let raw
  try {
    raw = await callModel(buildPrompt(text, { regexExpense, queryHint, undoHint, recentRecord }))
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
