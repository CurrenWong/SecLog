// utils/extractByModel.js
// 大模型结构化抽取（正则抽不到时的降级方案）。
//
// 设计：本模块不依赖 wx / CloudBase，模型调用通过 callModel 注入，
// 便于在 Node 环境单测（测试里传 mock callModel）。
//
// callModel(prompt) => Promise<string>  返回模型原始文本（可能含 markdown / 多余话术）
//
// 返回 { amount, category, note } 或 null（模型没抽到 / 校验不通过）

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

function validate(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  let amount = Number(parsed.amount)
  if (!Number.isFinite(amount) || amount === 0) return null
  if (Math.abs(amount) > MAX_ABS_AMOUNT) return null

  // 模型可能返回正数表示支出，这里按"positive=收入 / 负数或带type=支出"归一
  const type = parsed.type
  let signed
  if (type === 'income') signed = Math.abs(amount)
  else if (type === 'expense') signed = -Math.abs(amount)
  else signed = amount // 模型直接给带符号数字

  const category = VALID_CATEGORIES.has(parsed.category) ? parsed.category : '其他'
  const note = typeof parsed.note === 'string' ? parsed.note.slice(0, 20) : ''

  return { amount: signed, category, note }
}

// 构造抽取 prompt（要求模型只返回结构化 JSON，不啰嗦）
function buildPrompt(text) {
  return [
    '你是秒记记账助手的结构化提取器。从用户语句中提取一笔消费或收入。',
    '只输出一个 JSON 对象，不要任何解释或 markdown 之外的内容。',
    '字段：amount(数字，支出用负数、收入用正数), category(餐饮/交通/购物/居家/娱乐/医疗/教育/收入/其他), note(简短备注，≤20字)。',
    '如果用户语句不包含任何消费或收入意图，输出 {"amount":0}。',
    `用户输入：${text}`,
  ].join('\n')
}

// 主入口：调用模型抽取并校验
async function extractByModel(text, callModel) {
  if (!text || typeof callModel !== 'function') return null
  let raw
  try {
    raw = await callModel(buildPrompt(text))
  } catch (e) {
    return null // 模型调用失败，降级失败，交回上层不记账
  }
  const parsed = extractJson(raw)
  if (!parsed) return null
  // amount=0 视为无记账意图
  if (Number(parsed.amount) === 0) return null
  return validate(parsed)
}

module.exports = { extractByModel, buildPrompt, extractJson, validate, VALID_CATEGORIES }
