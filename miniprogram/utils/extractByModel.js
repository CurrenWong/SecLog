// utils/extractByModel.js
// 大模型最终拍板：结合正则线索 + 最近一笔上下文，输出统一结构化意图。
//
// 设计：本模块不依赖 wx / CloudBase，模型调用通过 callModel 注入，
// 便于在 Node 环境单测（测试里传 mock callModel）。
//
// callModel(prompt) => Promise<string>  返回模型原始文本（可能含 markdown / 多余话术）
//
// 返回统一结构：
//   { action: 'add',    amount, category, note }        → 记一笔新账
//   { action: 'correct', amount, category, note, target } → 更正（target: 'last' 或具体 _id）
//   { action: 'none' }                                  → 非记账意图（交给对话/闲聊）
//   null                                                → 模型调用失败 / 无法解析（保守不记）

// 与 parseExpense 保持一致的分类白名单，校验模型输出合法性
const VALID_CATEGORIES = new Set([
  '餐饮', '交通', '购物', '居家', '娱乐', '医疗', '教育', '收入', '其他',
])

// 金额合理范围（防止模型抽飞，如 38000000）
const MAX_ABS_AMOUNT = 1e7

// 从模型文本中抠出第一个 JSON 对象（兼容 ```json 代码块 或裸 JSON）
function extractJson(text) {
  if (!text) return null
  // 优先匹配 ```json ... ``` 代码块
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i)
  let jsonStr = null
  if (fenced) {
    jsonStr = fenced[1]
  } else {
    const m = text.match(/\{[\s\S]*?\}/)
    jsonStr = m ? m[0] : null
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

// 构造抽取 prompt
// regexHint: 正则初步抽取结果（可能 null），作为线索喂给模型
// recentRecord: 最近一笔记账（用于更正判断），格式 { _id, amount, category, note } 或 null
function buildPrompt(text, regexHint, recentRecord) {
  const lines = [
    '你是秒记记账助手的意图理解器。分析用户这句话，输出一个 JSON 对象，不要任何解释、不要 markdown 代码块标记、不要多余文字。',
    '',
    '字段说明：',
    '- action: 必填。"add"=记一笔新账；"correct"=更正刚才记的那笔（用户说"错了/改成X/应该是X/记成X了"等）；"none"=与记账无关（闲聊/提问/无明确消费收入）。',
    '- amount: 数字。支出用负数、收入用正数。correct 时填更正后的正确金额。',
    '- category: 餐饮/交通/购物/居家/娱乐/医疗/教育/收入/其他。',
    '- note: 简短备注（≤20字），比如"火锅""打车"。',
    '- target: 仅 correct 时需要。"last" 表示更正最近一笔。',
    '',
    '判断规则：',
    '1) 用户明确说出一笔消费或收入 → action:"add"。',
    '2) 用户说刚记的某笔不对、要改成别的 → action:"correct", target:"last"，amount 填正确值。',
    '3) 闲聊、提问、或无任何消费/收入意图 → action:"none"。',
    '',
  ]

  if (regexHint) {
    lines.push(`正则初步抽取线索（仅供参考，以语义为准，正则可能漏抽或误抽）：${JSON.stringify(regexHint)}`)
  } else {
    lines.push('正则未抽到明确金额（可能正则漏了，请你结合语义判断）。')
  }

  if (recentRecord) {
    lines.push(`最近一笔记账（用于判断 correct 意图）：${JSON.stringify(recentRecord)}`)
  }

  lines.push('')
  lines.push('示例：')
  lines.push('输入"中午跟同事吃了顿火锅大概五十多" → {"action":"add","amount":-55,"category":"餐饮","note":"火锅"}')
  lines.push('输入"发工资了八百块" → {"action":"add","amount":800,"category":"收入","note":"工资"}')
  lines.push('输入"想起来错了，是60" → {"action":"correct","target":"last","amount":-60,"category":"餐饮","note":"火锅"}')
  lines.push('输入"今天天气不错" → {"action":"none"}')
  lines.push('')
  lines.push(`用户输入：${text}`)

  return lines.join('\n')
}

// 主入口：调用模型抽取并校验，返回统一结构
// 返回：
//   { action: 'add', amount, category, note }
//   { action: 'correct', amount, category, note, target }
//   { action: 'none' }
//   null  （模型调用失败 / 无法解析）
async function extractByModel(text, callModel, opts = {}) {
  if (!text || typeof callModel !== 'function') return null
  const { regexHint = null, recentRecord = null } = opts
  let raw
  try {
    raw = await callModel(buildPrompt(text, regexHint, recentRecord))
  } catch (e) {
    return null // 模型调用失败，降级失败，交回上层不记账
  }
  const parsed = extractJson(raw)
  if (!parsed) return null

  // action 缺失或非法 → 视为 none
  const action = parsed.action
  if (action === 'none') return { action: 'none' }
  if (action === 'correct') {
    const rec = validateRecord(parsed)
    if (!rec) return { action: 'none' } // 更正但金额无效 → 不当记账
    const target = parsed.target === 'last' ? 'last' : (typeof parsed.target === 'string' ? parsed.target : 'last')
    return { action: 'correct', target, ...rec }
  }
  if (action === 'add') {
    const rec = validateRecord(parsed)
    if (!rec) return { action: 'none' } // 金额无效 → 不记
    return { action: 'add', ...rec }
  }
  // 兼容旧格式（无 action 字段但带 amount）→ 视为 add
  if (parsed.amount !== undefined) {
    const rec = validateRecord(parsed)
    if (!rec) return { action: 'none' }
    return { action: 'add', ...rec }
  }
  return { action: 'none' }
}

module.exports = { extractByModel, buildPrompt, extractJson, validateRecord, normalizeAmount, VALID_CATEGORIES }
