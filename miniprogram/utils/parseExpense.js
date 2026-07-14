// utils/parseExpense.js
// 从自然语言文本提取消费 / 收入信息。
// 纯函数，无 wx / this 依赖，便于单元测试。
// 返回 { amount, category, note } 或 null（非记账意图）。
//
// amount: 正数表示收入，负数表示支出（与 miaojiRecord 云函数约定一致）
// category: 餐饮 / 交通 / 购物 / 居家 / 娱乐 / 医疗 / 教育 / 收入 / 其他
// note: 用户原话去掉金额后的简短描述（截断 20 字）

// 收入关键词
const INCOME_RE = /(收入|工资|赚|收|到账|奖金|报销|分红)/i

// 金额提取（按优先级匹配）
const AMOUNT_PATTERNS = [
  /(?:花|支|付|买|消费|支出|付了|花了|用了|请客|喝|吃|打车|收到|赚|挣|报销)[^0-9\-]*?(-?\d+(?:\.\d+)?)\s*(?:元|块|刀|rmb)?/i,
  /(-?\d+(?:\.\d+)?)\s*(?:元|块|刀|rmb)/i,
  /(-?\d+(?:\.\d+)?)/,
]

// 分类映射
const CATEGORY_MAP = [
  { keys: ['午饭', '午餐', '早饭', '早餐', '晚饭', '晚餐', '饭', '吃', '餐', '喝', '奶茶', '咖啡', '餐厅'], cat: '餐饮' },
  { keys: ['打车', '地铁', '公交', '车', '油', '停车', '高铁', '火车', '飞机', '机票', '滴滴'], cat: '交通' },
  { keys: ['买', '购', '衣服', '鞋', '包', '数码', '手机', '电脑', '淘宝', '京东', '超市'], cat: '购物' },
  { keys: ['房租', '水电', '物业', '家居', '家具', '日用品'], cat: '居家' },
  { keys: ['电影', '游戏', '娱乐', '唱k', 'ktv', '旅游', '玩'], cat: '娱乐' },
  { keys: ['药', '医', '医院', '诊所', '体检'], cat: '医疗' },
  { keys: ['书', '课', '培训', '学费', '教育'], cat: '教育' },
]

// 消费 / 收入意图关键词（命中任一才视为记账意图，避免"幸运数字7"被误记）
const INTENT_KEYS = [
  '花', '支', '付', '买', '消费', '支出', '用了', '请客', '喝', '吃', '打车',
  '收入', '工资', '赚', '收', '到账', '奖金', '报销', '分红',
  '午饭', '午餐', '早饭', '早餐', '晚饭', '晚餐', '饭', '餐', '奶茶', '咖啡', '餐厅',
  '地铁', '公交', '油', '停车', '高铁', '火车', '飞机', '机票', '滴滴',
  '衣服', '鞋', '包', '数码', '手机', '电脑', '淘宝', '京东', '超市',
  '房租', '水电', '物业', '家居', '家具', '日用品',
  '电影', '游戏', '娱乐', '唱k', 'ktv', '旅游', '玩',
  '药', '医', '医院', '诊所', '体检',
  '书', '课', '培训', '学费', '教育',
  '元', '块', '刀', 'rmb', '¥',
]

function hasIntent(text) {
  return INTENT_KEYS.some((k) => text.includes(k))
}

function extractAmount(text) {
  for (const p of AMOUNT_PATTERNS) {
    const m = text.match(p)
    if (m) return parseFloat(m[1])
  }
  return null
}

function stripAmount(text) {
  return text.replace(/[-+]?\d+(?:\.\d+)?\s*(?:元|块|刀|rmb)?/i, '').trim().slice(0, 20)
}

function parseExpense(text) {
  if (!text) return null
  // 无记账意图（没有任何消费/收入关键词）则忽略，避免误记纯数字文本
  if (!hasIntent(text)) return null

  const isIncome = INCOME_RE.test(text)
  const raw = extractAmount(text)
  if (raw === null || isNaN(raw)) return null

  const amount = isIncome ? Math.abs(raw) : -Math.abs(raw)

  if (isIncome) {
    return { amount, category: '收入', note: stripAmount(text) }
  }

  let category = '其他'
  for (const item of CATEGORY_MAP) {
    if (item.keys.some((k) => text.includes(k))) {
      category = item.cat
      break
    }
  }

  return { amount, category, note: stripAmount(text) }
}

module.exports = { parseExpense }
