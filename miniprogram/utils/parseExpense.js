// utils/parseExpense.js
// 从自然语言文本提取消费 / 收入信息。
// 纯函数，无 wx / this 依赖，便于单元测试。
// 返回 { amount, category, note } 或 null（非记账意图）。
//
// amount: 正数表示收入，负数表示支出（与 miaojiRecord 云函数约定一致）
// category: 餐饮 / 旅游 / 交通 / 购物 / 居家 / 娱乐 / 医疗 / 教育 / 收入 / 其他
// note: 用户原话去掉金额后的简短描述（截断 20 字）

// 收入关键词
const INCOME_RE = /(收入|工资|赚|收|到账|奖金|报销|分红)/i

// ============================================================
// 分类关键词单一数据源
// 新增关键词时只需改这里，AMOUNT_PATTERNS、CATEGORY_MAP、INTENT_KEYS 全部自动派生。
// ============================================================
const CATEGORY_KEYWORDS = {
  餐饮: ['午饭', '午餐', '早饭', '早餐', '晚饭', '晚餐', '饭', '吃', '餐', '喝', '奶茶', '咖啡', '餐厅', '火锅', '小吃', '快餐', '外卖',
        // Fix #3: 英文/品牌别名
        'starbucks', '星巴克', 'kfc', '肯德基', 'mcdonald', '麦当劳', '麦门', 'burgerking', '汉堡王', '赛百味', 'pizza', '必胜客', '瑞幸', 'luckin', '蜜雪', '喜茶', '奈雪', '一点点', 'coco',
        '冰淇淋', '雪糕', '冰棍', '冰品', '哈根达斯', '冰激凌',
        ],
  交通: ['打车', '地铁', '公交', '车', '油', '停车', '高铁', '火车', '飞机', '机票', '滴滴', 'taxi', 'bus', 'subway', 'metro', 'uber', 'lyft', 'tram', 'train', 'flight', '顺风车', '拼车', '自驾', '过路费', '高速费', '加油'],
  购物: ['买', '购', '衣服', '鞋', '包', '数码', '手机', '电脑', '淘宝', '京东', '超市', '网购', '快递'],
  居家: ['房租', '水电', '物业', '家居', '家具', '日用品', '生活用品', '理发', '美容'],
  旅游: ['旅游', '出游', '旅行', '自驾游', '跟团', '自由行'],
  娱乐: ['电影', '游戏', '娱乐', '唱k', 'ktv', '玩', '健身', '运动', '演唱会', '话剧', '展览'],
  医疗: ['药', '医', '医院', '诊所', '体检', '看病', '挂号', '买药'],
  教育: ['书', '课', '培训', '学费', '教育', '学习', '文具', '考试'],
}

// 通用动作词（跨所有分类的动作词，无类别归属，单独列出参与 INTENT_KEYS 和 AMOUNT_PATTERNS）
const ACTION_KEYWORDS = ['花', '支', '付', '买', '消费', '支出', '付了', '花了', '用了', '请客', '收到', '赚', '挣']

// 收入专属关键词（归类为"收入"，不归任何消费分类）
const INCOME_KEYWORDS = ['工资', '奖金', '收入', '到账', '报销', '分红']

// ============================================================
// 以下三个数据结构全部从上面自动派生，禁止手动维护
// ============================================================

// 金额提取：类别词/动作词 + 数字（数字必须紧跟类别/动作词，不接受裸数字）
// 关键：金额【必须】带单位词（元/块/刀/rmb）或类别/动作词前缀，
// 不允许裸数字（避免"第3名奖金"抽成3、"幸运数字7"被记）。
const AMOUNT_PATTERNS = [
  // 餐饮类目词（午饭/早餐/晚餐…）后跟数字也算消费（"午饭38"无单位也应记）
  new RegExp(`(?:${CATEGORY_KEYWORDS.餐饮.join('|')})[^0-9\\-]*?(-?\\d+(?:\\.\\d+)?)`, 'i'),
  // 收入类词
  new RegExp(`(?:${INCOME_KEYWORDS.join('|')})[^0-9\\-]*?(-?\\d+(?:\\.\\d+)?)`, 'i'),
  // 动作词 + 数字/单位（"花了38""付了50元"）
  new RegExp(`(?:${ACTION_KEYWORDS.join('|')})[^0-9\\-]*?(-?\\d+(?:\\.\\d+)?)\\s*(?:元|块|刀|rmb)?`, 'i'),
  // 交通/购物/旅游等类别词 + 数字/单位（补漏：打车/加油/网购等带单位）
  new RegExp(`(?:${[...CATEGORY_KEYWORDS.交通, ...CATEGORY_KEYWORDS.购物, ...CATEGORY_KEYWORDS.居家, ...CATEGORY_KEYWORDS.娱乐, ...CATEGORY_KEYWORDS.旅游, ...CATEGORY_KEYWORDS.医疗, ...CATEGORY_KEYWORDS.教育].join('|')})[^0-9\\-]*?(-?\\d+(?:\\.\\d+)?)\\s*(?:元|块|刀|rmb)?`, 'i'),
  // Fix #2: 中文数字 + 单位
  new RegExp(`(?:${Object.values(CATEGORY_KEYWORDS).flat().concat(ACTION_KEYWORDS).join('|')})[^0-9\\u4e00-\\u9fff\\-]*?([零〇一二两三四五六七八九壹贰叁肆伍陆柒捌玖十拾百佰千]+)\\s*(?:元|块|刀|rmb)?`, 'i'),
  // 纯数字 + 单位（"38元""100块"）
  /(-?\d+(?:\.\d+)?)\s*(?:元|块|刀|rmb)/i,
]

// 分类映射：从 CATEGORY_KEYWORDS 派生
// 顺序：旅游最高优先级（独立分类），其次餐饮/娱乐/交通——用户明确要求"旅游"单列
// 且优先于娱乐和交通，故"旅游高速费"归旅游而非交通。
const CATEGORY_MAP = [
  { keys: CATEGORY_KEYWORDS.旅游, cat: '旅游' },
  { keys: CATEGORY_KEYWORDS.餐饮, cat: '餐饮' },
  { keys: CATEGORY_KEYWORDS.娱乐, cat: '娱乐' },
  { keys: CATEGORY_KEYWORDS.交通, cat: '交通' },
  { keys: CATEGORY_KEYWORDS.购物, cat: '购物' },
  { keys: CATEGORY_KEYWORDS.居家, cat: '居家' },
  { keys: CATEGORY_KEYWORDS.医疗, cat: '医疗' },
  { keys: CATEGORY_KEYWORDS.教育, cat: '教育' },
]

// 意图关键词：从 CATEGORY_KEYWORDS + ACTION_KEYWORDS + INCOME_KEYWORDS 派生
const INTENT_KEYS = [
  ...ACTION_KEYWORDS,
  ...INCOME_KEYWORDS,
  ...Object.values(CATEGORY_KEYWORDS).flat(),
]

function hasIntent(text) {
  const lower = text.toLowerCase()
  return INTENT_KEYS.some((k) => lower.includes(k.toLowerCase()))
}

function extractAmount(text) {
  for (const p of AMOUNT_PATTERNS) {
    const m = text.match(p)
    if (m) {
      const raw = m[1]
      // Fix #2: 中文数字（五十/三十/两百五 等）parseFloat 得 NaN，用 parseChineseAmount 兜底
      if (/[零〇一二两三四五六七八九壹贰叁肆伍陆柒捌玖十拾百佰千]/.test(raw)) {
        const cn = parseChineseAmount(raw)
        if (cn !== null) return cn
        continue
      }
      let val = parseFloat(raw)
      // Fix #6: 中文口语金额 "X块Y"（47块5 = 47.5）。
      // 金额正则常把 "47块" 中的 "块" 吃进 m[0]，其后紧跟一位小鱼角（如 "5"）。
      // 例："高速费47块5" → m[0]="高速费47块"，after="5" → 合并成 47.5。
      const after = text.slice(m.index + m[0].length)
      const jiao = after.match(/^(\d)(?!\d)/)
      if (jiao) {
        val = val + parseInt(jiao[1], 10) / 10
      }
      return val
    }
  }
  return null
}

function stripAmount(text) {
  // Fix #6: 剥掉金额本体，含口语 "X块Y"（47块5 = 47.5）里的角数字。
  return text
    // 情况1: 数字+单位(+可选角数字)，如 "47块5" / "47元5" / "47块" / "47元"
    .replace(/[-+]?\d+(?:\.\d+)?\s*(?:元|块|刀|rmb)\s*\d?(?!\d)/i, '')
    // 情况2: 纯数字无单位，如 "打车45" / "午饭38" 里的 "45" / "38"
    .replace(/[-+]?\d+(?:\.\d+)?/i, '')
    // 情况3: 金额正则已吃掉整数、单位后残留的 "块+一位角数字"，如 "高速费5"
    .replace(/(?:元|块|块钱)\s*\d(?!\d)/i, '')
    .trim()
    .slice(0, 20)
}

// 通用数字+文本兜底：覆盖白名单外的新品类词（"谷子20""手办15""海报8"等）。
// 设计原则：开头有 ≥1 个中文字符（避免纯英文+数字如"iphone 12"）+ 结尾是数字 + 排除明显非消费语境。
// 排除项：岁/号/年/月/日/点/分/秒/%/第/楼/室/层/kg/g/ml/cm/mm/公里/千米/个/只/条/片/颗/粒/朵/张/根（这些"数字+量词"组合几乎都不是记账意图）
const NON_EXPENSE_NUMBER_RE = /(岁|号|年|月|日|点|分|秒|%|第|楼|室|层|kg|g|ml|cm|mm|公里|千米|个|只|条|片|颗|粒|朵|张|根|数字|身高)/i
function matchesExpenseFallback(text) {
  if (NON_EXPENSE_NUMBER_RE.test(text)) return false
  // 开头必须是中文或拼音字母（拼音输入很常见："niunai100"=牛奶100、"newnew100"也是拼音/英文混合）
  // 不接受纯符号/纯数字开头，避免误中
  if (!/^[a-zA-Z\u4e00-\u9fa5]/.test(text)) return false
  // 末尾必须是数字（数字可带小数点）
  if (!/\d+(?:\.\d+)?\s*$/.test(text)) return false
  // 至少 3 个字符（避免"a 1"这种短文本误中）
  if (text.trim().length < 3) return false
  return true
}

// 撤回意图识别：用户想【删除】刚才记的一笔。确定性正则（不调模型，即时）。
// 只认明确的"删除"动作词；"错了/不对/改"等交给模型判断是「更正」还是「无意图」。
// 命中返回 true；非撤回意图返回 false。
const UNDO_RE = /(撤回|撤销|删掉|删除|取消记录|不要记了|别记了|退了重记|记错了|弄错了|搞错了|算错了|刚才那笔|刚刚那笔|上一笔不对|取消吧|撤回吧|帮我撤了)/i
function parseUndo(text) {
  if (!text) return false
  return UNDO_RE.test(text)
}

function parseExpense(text) {
  if (!text) return null

  const isIncome = INCOME_RE.test(text)

  // 主路径：已知消费/收入意图词 → 抽金额
  if (hasIntent(text)) {
    const raw = extractAmount(text)
    if (raw !== null && !isNaN(raw)) {
      const amount = isIncome ? Math.abs(raw) : -Math.abs(raw)
      if (isIncome) return { amount, category: '收入', note: stripAmount(text), _date: parseDateHint(text) }
      let category = '其他'
      const lower = text.toLowerCase()
      for (const item of CATEGORY_MAP) {
        if (item.keys.some((k) => lower.includes(k.toLowerCase()))) {
          category = item.cat
          break
        }
      }
      return { amount, category, note: stripAmount(text), _date: parseDateHint(text) }
    }
  }

  // 兜底路径（关键！）：用户说新词/白名单外的品类（"谷子20""手办15""海报8"等）
  // 之前的版本此处直接 return null，导致 suppress agent-ui 不触发，模型幻觉"已记"但代码没真记账。
  // 现在用启发式兜底：开头中文 + 结尾数字 + 排除非消费量词 → 视为记账意图，归"其他"分类。
  // 副作用：模型（如 hy3）拿到 regexExpense 后走 record 分支 → doAdd 真正写库，不再幻觉。
  if (!isIncome && matchesExpenseFallback(text)) {
    const m = text.match(/(\d+(?:\.\d+)?)\s*$/i)
    if (m) {
      const amount = -Math.abs(parseFloat(m[1]))
      return { amount, category: null, note: stripAmount(text), _date: parseDateHint(text) }
    }
  }

  return null
}

// 一句话多笔记账：从文本提取多笔消费/收入。
// 返回数组：[{ amount, category, note }, ...]，无记账意图返回 []。
// 支持两种写法：
//   1) 分隔符分句：「午饭38，打车25，买菜60」→ 逗号/顿号/「和」「并」等切分后逐句抽
//   2) 连续无分隔：「午饭38打车25买菜60」→ 全局扫描所有「类别词+金额」组合
function parseExpenses(text) {
  if (!text) return []
  // 先按分隔符拆，覆盖绝大多数口语场景
  const segs = text.split(/[，,、。；;\s]+|和|并|以及|加上|再加|还有|又|跟|与/).filter((s) => s && s.trim())
  const result = []
  if (segs.length > 1) {
    for (const seg of segs) {
      const one = parseExpense(seg)
      if (one) result.push(one)
    }
  }
  if (result.length >= 2) return result
  // 分句没拆出多笔 → 尝试全局扫描连续写法（「午饭38打车25」）
  // 找所有金额出现位置，每笔关联其前最近类别关键词
  const allMatches = []
  for (const p of AMOUNT_PATTERNS) {
    const re = new RegExp(p.source, 'gi')
    let m
    while ((m = re.exec(text)) !== null) {
      allMatches.push({ index: m.index, amount: parseFloat(m[1]) })
    }
  }
  if (allMatches.length < 2) return result // 确实只有一笔或无
  // 去重（按 index）
  const uniq = []
  const seen = new Set()
  for (const am of allMatches) {
    if (seen.has(am.index)) continue
    seen.add(am.index)
    uniq.push(am)
  }
  uniq.sort((a, b) => a.index - b.index)
  const items = []
  for (const am of uniq) {
    const before = text.slice(0, am.index + String(am.amount).length)
    // 就近类别：从当前金额往前找最近命中的类别关键词
    let category = '其他'
    let bestPos = -1
    for (const item of CATEGORY_MAP) {
      for (const k of item.keys) {
        const pos = before.lastIndexOf(k)
        if (pos >= bestPos) {
          bestPos = pos
          category = item.cat
        }
      }
    }
    // 收入判断（整句含收入词则视为收入）
    const isIncome = INCOME_RE.test(text)
    const amount = isIncome ? Math.abs(am.amount) : -Math.abs(am.amount)
    items.push({ amount, category, note: '' })
  }
  return items
}

// 统计查询意图识别：用户想看汇总/分类/近期记录，而非记账。
// 返回 { type: 'month'|'day'|'category'|'recent'|'range', ... } 或 null（非查询意图）。
//
// type 说明：
//   month    → 本月/这个月花了多少
//   day      → 今天花了多少
//   category → 某分类（餐饮/交通…）花了多少，需带分类词
//   recent   → 最近记了啥 / 都记了些啥 / 明细
//   range    → 任意时间段（今年/去年/最近N天/从X到Y/上半年…），带 range 对象
//
// range 对象（mode 三选一）：
//   { mode:'year', year:Number }
//   { mode:'lastN', days:Number }
//   { mode:'between', from:'YYYY-MM-DD', to:'YYYY-MM-DD' }
const QUERY_RE = /(花了多少|花了|支出|收入|开销|消费|统计|汇总|明细|记了|花销|账单|还剩|剩多少|多少钱|最近|都花了|花了啥|记录)/i
const TIME_THIS_MONTH = /(这个月|这月|本月|当月|这个月来|月)/i
const TIME_TODAY = /(今天|今日|当天)/i
const TIME_RECENT = /(最近|都记了|记了啥|记了些啥|明细|都花了|花了啥|账单|记录)/i
// —— 任意时间段正则（range 模式预判）——
const TIME_YEAR = /(今年|去年|前年|\d{4}\s*年)/ // 今年/去年/2025年
// 最近 N 天/周/月/年：阿拉伯数字（最近30天/近7天）或中文数字（近一周/近两天）
const TIME_LASTN = /(最近|近|过去)\s*(\d+|一|两|二|三|四|五|六|七|八|九|十)\s*(天|日|周|个月|月|年)/
const TIME_BETWEEN = /(从|自)\s*\d{1,2}\s*(月|号|日)\s*(到|至)\s*\d{1,2}\s*(月|号|日)|(上半年|下半年|前半年|后半年)|\d{4}\s*年?\s*\d{1,2}\s*月?\s*(到|至|~|-)\s*\d{4}\s*年?\s*\d{1,2}\s*月?|\d{1,2}\s*月\s*(到|至)\s*\d{1,2}\s*月/
const CATEGORY_QUERY_MAP = [
  { keys: ['餐饮', '吃饭', '吃', '午饭', '晚餐', '早餐', '火锅', '奶茶', '咖啡', '餐厅'], cat: '餐饮' },
  { keys: ['旅游', '出游', '旅行', '自驾游', '跟团', '自由行'], cat: '旅游' },
  { keys: ['交通', '打车', '地铁', '公交', '油费', '停车', '高铁', '火车', '机票', '滴滴'], cat: '交通' },
  { keys: ['购物', '买', '衣服', '鞋', '包', '数码', '手机', '电脑', '淘宝', '京东', '超市'], cat: '购物' },
  { keys: ['居家', '房租', '水电', '物业', '家居', '家具', '日用品'], cat: '居家' },
  { keys: ['娱乐', '电影', '游戏', 'ktv', '玩'], cat: '娱乐' },
  { keys: ['医疗', '药', '医院', '诊所', '体检'], cat: '医疗' },
  { keys: ['教育', '书', '课', '培训', '学费'], cat: '教育' },
]

// 根据"N + 单位"换算成天数（周→7，月→30，年→365）
function unitToDays(n, unit) {
  if (unit === '周') return n * 7
  if (unit === '个月' || unit === '月') return n * 30
  if (unit === '年') return n * 365
  return n // 天/日
}

function parseRange(text) {
  const now = new Date()
  const thisYear = now.getFullYear()
  // 去年 / 前年 / 某年
  if (TIME_YEAR.test(text)) {
    const m = text.match(/(\d{4})\s*年/)
    if (m) return { mode: 'year', year: Number(m[1]) }
    if (/前年/.test(text)) return { mode: 'year', year: thisYear - 2 }
    if (/去年/.test(text)) return { mode: 'year', year: thisYear - 1 }
    return { mode: 'year', year: thisYear } // 今年
  }
  // 最近 N 天/周/月/年（支持中文数字：近一周 / 近两天）
  if (TIME_LASTN.test(text)) {
    const m = text.match(/(最近|近|过去)\s*(\d+|一|两|二|三|四|五|六|七|八|九|十)\s*(天|日|周|个月|月|年)/)
    if (m) {
      const cn = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
      const n = cn[m[2]] !== undefined ? cn[m[2]] : Number(m[2])
      const days = unitToDays(n, m[3])
      return { mode: 'lastN', days }
    }
  }
  // 从 X 到 Y / 上半年 / 下半年 / 某年某月 到 某年某月 / 同今年 X月 到 Y月
  if (TIME_BETWEEN.test(text)) {
    // 上半年 / 下半年（相对今年）
    if (/(上半年|前半年)/.test(text)) {
      return { mode: 'between', from: `${thisYear}-01-01`, to: `${thisYear}-06-30` }
    }
    if (/(下半年|后半年)/.test(text)) {
      return { mode: 'between', from: `${thisYear}-07-01`, to: `${thisYear}-12-31` }
    }
    // 某年某月 到 某年某月（如 "2025年1月 到 2025年6月" 或 "2025年1月-6月"）
    const ym = text.match(/(\d{4})\s*年?\s*(\d{1,2})\s*月?\s*(?:到|至|~|-)\s*(\d{4})\s*年?\s*(\d{1,2})\s*月?/)
    if (ym) {
      const y1 = ym[1]
      const m1 = ym[2].padStart(2, '0')
      const y2 = ym[3]
      const m2 = ym[4].padStart(2, '0')
      const lastDay = new Date(Number(y2), Number(m2), 0).getDate()
      return { mode: 'between', from: `${y1}-${m1}-01`, to: `${y2}-${m2}-${lastDay}` }
    }
    // 简单 "X月 到 Y月"（同今年，无年份）
    const mm = text.match(/(?:从|自)?\s*(\d{1,2})\s*月\s*(?:到|至)\s*(\d{1,2})\s*月/)
    if (mm) {
      const m1 = mm[1].padStart(2, '0')
      const m2 = mm[2].padStart(2, '0')
      const lastDay = new Date(thisYear, Number(mm[2]), 0).getDate()
      return { mode: 'between', from: `${thisYear}-${m1}-01`, to: `${thisYear}-${m2}-${lastDay}` }
    }
  }
  return null
}

// 肯定/确认词（用户对上轮问题的确认，如"对""嗯""是""yes"等）
// 配合 ctx 使用：当前是肯定词 + 上一轮是查询 → 复用上次 query
const AFFIRMATIVE_RE = /^(对|嗯|是|好的|好|yes|y|ok|可以|行|是的|对对|对对对|嗯嗯|是的是的|好的好的|嗯好|好的呀)$/i
const NEGATIVE_RE = /^(不|不对|不是|错了|不要|算了|nope|no)$/i

function parseQuery(text, ctx) {
  if (!text) return null

  // 上下文复用：肯定词 + ctx 有 query → 复用上次查询（"对""嗯""是"应答上一轮）
  const t = text.trim()
  if (ctx && ctx.query && AFFIRMATIVE_RE.test(t)) {
    return ctx.query
  }
  // 否定词 + ctx 有 query → 视为取消（返回 null，不要走查询）
  if (ctx && ctx.query && NEGATIVE_RE.test(t)) {
    return null
  }

  if (!QUERY_RE.test(text)) return null // 没有查询信号词 → 不是查询

  // 任意时间段？（今年/去年/最近N天/区间）— 优先于分类/本月判断。
  // 注意：年份数字/天数数字属于查询意图的一部分，需在"含金额即记账"拦截前处理。
  const range = parseRange(text)
  if (range) {
    return { type: 'range', range }
  }

  // 含具体金额数字（如"38块"）→ 是记账语句，不是查询（避免"午饭花了38块"被误判为查餐饮）
  if (/\d/.test(text)) return null

  // 指定分类？
  // 关键：含"明细/最近/记录" + 分类词 → 走 recent 带 category（明细列表），而不是 category 统计总和
  // 例："餐饮明细"应返回餐饮的记录列表，不是"这个月餐饮一共花了 X"
  if (TIME_RECENT.test(text)) {
    for (const item of CATEGORY_QUERY_MAP) {
      if (item.keys.some((k) => text.includes(k))) {
        return { type: 'recent', category: item.cat }
      }
    }
    return { type: 'recent' }
  }
  // 纯分类查询（"餐饮花了多少"）→ 统计总和
  for (const item of CATEGORY_QUERY_MAP) {
    if (item.keys.some((k) => text.includes(k))) {
      return { type: 'category', category: item.cat }
    }
  }
  // 昨天 / 前天？（转成 range 单日区间，复用已支持的 startDate/endDate 统计）
  const yest = text.match(/(昨|前\s*天|大前天)/)
  if (yest) {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    let back = 1
    if (/前\s*天/.test(text) && !/昨/.test(text)) back = 2
    if (/大前天/.test(text)) back = 3
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    const ds = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    return { type: 'range', range: { mode: 'between', from: ds, to: ds }, rangeLabel: back === 1 ? '昨天' : back === 2 ? '前天' : '大前天' }
  }
  // 本周 / 上周 / 这周？（自然周，周一起算；上周=往前 7 天）
  const week = text.match(/(上\s*周|本\s*周|这\s*周|这礼拜|上礼拜|这周|上周)/)
  if (week) {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const dow = (now.getDay() + 6) % 7 // 周一=0 ... 周日=6
    let start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow)
    let label = '本周'
    if (/上\s*周/.test(text) || /^上周/.test(text) || /上礼拜/.test(text)) {
      start = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7)
      label = '上周'
    }
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)
    const from = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`
    const to = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`
    return { type: 'range', range: { mode: 'between', from, to }, rangeLabel: label }
  }
  // 今天？
  if (TIME_TODAY.test(text)) return { type: 'day' }
  // 最近/明细？
  if (TIME_RECENT.test(text)) return { type: 'recent' }
  // 本月（默认）
  if (TIME_THIS_MONTH.test(text)) return { type: 'month', month: 'this' }
  // 兜底：含查询词但没命中时间/分类 → 视为本月汇总
  return { type: 'month', month: 'this' }
}

// ============================================================
// Fix #2: 中文数字解析函数
// ============================================================
const CN_DIGIT = { 零:0, 〇:0, 一:1, 壹:1, 二:2, 贰:2, 两:2, 三:3, 叁:3, 四:4, 肆:4,
                   五:5, 伍:5, 六:6, 陆:6, 七:7, 柒:7, 八:8, 捌:8, 九:9, 玖:9 }

function chineseStrToNum(s) {
  let result = 0
  let curDigit = 0
  let hasUnit = false
  let lastUnit = null // '十' | '百' | '千' | null（用于处理 "一百五" 这种口语）
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (CN_DIGIT[c] !== undefined) {
      curDigit = CN_DIGIT[c]
    } else if (c === '十' || c === '拾') {
      if (curDigit === 0 && i === 0) curDigit = 1
      result += curDigit * 10
      curDigit = 0
      hasUnit = true
      lastUnit = '十'
    } else if (c === '百' || c === '佰') {
      result += (curDigit || 1) * 100
      curDigit = 0
      hasUnit = true
      lastUnit = '百'
    } else if (c === '千') {
      result += (curDigit || 1) * 1000
      curDigit = 0
      hasUnit = true
      lastUnit = '千'
    }
  }
  if (curDigit > 0) {
    // "一百五"（百后无十 + 数字）→ 一百+五十 = 150；"一百零五" → 105
    // 启发式：百/千 之后无十 + 跟着数字 → 视为十位（×10）
    if ((lastUnit === '百' || lastUnit === '千') && !s.includes('十') && !s.includes('拾')) {
      result += curDigit * 10
    } else {
      result += curDigit
    }
  }
  return result > 0 || hasUnit ? result : null
}

function parseChineseAmount(text) {
  if (!text) return null
  const segs = text.match(/[零〇一二两三四五六七八九壹贰叁肆伍陆柒捌玖十拾百佰千]+(?:多|几|来)?/g)
  if (!segs) return null
  let best = null
  for (const seg of segs) {
    const clean = seg.replace(/(多|几|来)$/, '')
    if (!clean) continue
    const v = chineseStrToNum(clean)
    if (v !== null && (best === null || clean.length > best.len)) best = { v, len: clean.length }
  }
  return best ? best.v : null
}

// ============================================================
// Fix #1: 过去日期识别（返回 YYYY-MM-DD 或 null）
// ============================================================
function pad2(n) { return String(n).padStart(2, '0') }
function fmtDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function parseDateHint(text) {
  if (!text) return null
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (/大前天/.test(text)) {
    const d = new Date(today); d.setDate(d.getDate() - 3); return fmtDate(d)
  }
  if (/前\s*天/.test(text) && !/昨天/.test(text)) {
    const d = new Date(today); d.setDate(d.getDate() - 2); return fmtDate(d)
  }
  if (/昨\s*天/.test(text)) {
    const d = new Date(today); d.setDate(d.getDate() - 1); return fmtDate(d)
  }
  const wkMap = { 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 日:0, 天:0, 末:0 }
  const wkMatch = text.match(/(上\s*周|本\s*周|这\s*周)?\s*周\s*([一二三四五六日天末])/)
  if (wkMatch) {
    const target = wkMap[wkMatch[2]]
    if (target !== undefined) {
      const curDow = today.getDay()
      let diff = (curDow - target + 7) % 7
      if (diff === 0) diff = 7
      if (/上\s*周/.test(wkMatch[1] || '')) diff += 7
      const d = new Date(today); d.setDate(d.getDate() - diff); return fmtDate(d)
    }
  }
  const dayAgo = text.match(/(\d+)\s*天\s*前/)
  if (dayAgo) {
    const n = parseInt(dayAgo[1], 10)
    const d = new Date(today); d.setDate(d.getDate() - n); return fmtDate(d)
  }
  if (/上\s*(上\s*个\s*月|个\s*月|月)/.test(text)) {
    // 边界：1月-1=0月→去年12月，OK；但 getDate() 可能超出新月天数（如7/31 - 1月 → 6/31 不存在 → Date 自动滚到 7/1）
    // 修复：用 new Date(year, month+1, 0) 取新月最后一天，clamp 一下
    const prevYear = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear()
    const prevMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1
    const lastDayOfPrevMonth = new Date(prevYear, prevMonth + 1, 0).getDate()
    const day = Math.min(today.getDate(), lastDayOfPrevMonth)
    return fmtDate(new Date(prevYear, prevMonth, day))
  }
  const cnDayMap = { 一:1, 两:2, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10 }
  const cnDay = text.match(/([零〇一二两三四五六七八九十])\s*天\s*前/)
  if (cnDay && cnDayMap[cnDay[1]]) {
    const d = new Date(today); d.setDate(d.getDate() - cnDayMap[cnDay[1]]); return fmtDate(d)
  }
  return null
}

module.exports = { parseExpense, parseExpenses, parseUndo, parseQuery, parseDateHint, parseChineseAmount }
