// utils/__tests__/parseExpense.test.js
// 覆盖常见品牌词 + 数字（无单位）的回归测试。运行：node miniprogram/utils/__tests__/parseExpense.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseExpense, parseExpenses, parseQuery } = require('../parseExpense')

// —— 修复回归：滴滴 + 数字（无单位）必须识别（之前 null → 用户感知"无回复"）——
test('滴滴17.7 → 交通 -17.7', () => {
  const r = parseExpense('滴滴17.7')
  assert.equal(r.amount, -17.7)
  assert.equal(r.category, '交通')
})

test('滴滴 17.7（带空格）→ 交通 -17.7', () => {
  const r = parseExpense('滴滴 17.7')
  assert.equal(r.amount, -17.7)
  assert.equal(r.category, '交通')
})

test('滴滴17.7元 → 交通 -17.7（已有兼容）', () => {
  const r = parseExpense('滴滴17.7元')
  assert.equal(r.amount, -17.7)
  assert.equal(r.category, '交通')
})

test('滴滴打车17.7 → 交通 -17.7', () => {
  const r = parseExpense('滴滴打车17.7')
  assert.equal(r.amount, -17.7)
  assert.equal(r.category, '交通')
})

test('打滴滴 17.7 → 交通 -17.7', () => {
  const r = parseExpense('打滴滴 17.7')
  assert.equal(r.amount, -17.7)
  assert.equal(r.category, '交通')
})

// —— 边界：不应误中 ——
test('仅"滴滴"无金额 → null', () => {
  assert.equal(parseExpense('滴滴'), null)
})

test('仅"滴滴打车"无金额 → null', () => {
  assert.equal(parseExpense('滴滴打车'), null)
})

test('"滴滴abc" → null（金额非数字）', () => {
  assert.equal(parseExpense('滴滴abc'), null)
})

test('仅"17.7" → null（无意图词）', () => {
  assert.equal(parseExpense('17.7'), null)
})

// —— 多笔场景 ——
test('午饭38，滴滴17.7 → 两笔', () => {
  const list = parseExpenses('午饭38，滴滴17.7')
  assert.equal(list.length, 2)
  assert.equal(list[0].category, '餐饮')
  assert.equal(list[0].amount, -38)
  assert.equal(list[1].category, '交通')
  assert.equal(list[1].amount, -17.7)
})

test('滴滴17.7 打车25.5 → 两笔交通', () => {
  const list = parseExpenses('滴滴17.7 打车25.5')
  assert.equal(list.length, 2)
  assert.equal(list[0].category, '交通')
  assert.equal(list[0].amount, -17.7)
  assert.equal(list[1].category, '交通')
  assert.equal(list[1].amount, -25.5)
})

// —— 现有打车 + 单位形式不能回归 ——
test('打车 17.7 → 交通 -17.7', () => {
  const r = parseExpense('打车 17.7')
  assert.equal(r.amount, -17.7)
  assert.equal(r.category, '交通')
})

// —— 英文消费词 + 数字（无单位）必须识别 ——
// 场景：用户输入中英混合（如"taxi 17.7"），原本解析挂 → 触发模型幻觉说"已记账"但实际无 doAdd
// 修复后 regexExpense 有值 → likelyNonChat=true → suppress agent-ui → 走 doAdd 真正记账
test('taxi 17.7 → 交通 -17.7（防模型幻觉）', () => {
  const r = parseExpense('taxi 17.7')
  assert.equal(r.amount, -17.7)
  assert.equal(r.category, '交通')
})

test('taxi17.7 → 交通 -17.7', () => {
  const r = parseExpense('taxi17.7')
  assert.equal(r.amount, -17.7)
  assert.equal(r.category, '交通')
})

test('bus 5 → 交通 -5', () => {
  const r = parseExpense('bus 5')
  assert.equal(r.amount, -5)
  assert.equal(r.category, '交通')
})

test('subway 6 → 交通 -6', () => {
  const r = parseExpense('subway 6')
  assert.equal(r.amount, -6)
  assert.equal(r.category, '交通')
})

test('叫了辆taxi 17.7 → 交通 -17.7', () => {
  const r = parseExpense('叫了辆taxi 17.7')
  assert.equal(r.amount, -17.7)
  assert.equal(r.category, '交通')
})

test('Uber 20 → 交通 -20', () => {
  const r = parseExpense('Uber 20')
  assert.equal(r.amount, -20)
  assert.equal(r.category, '交通')
})

test('Lyft 25 → 交通 -25', () => {
  const r = parseExpense('Lyft 25')
  assert.equal(r.amount, -25)
  assert.equal(r.category, '交通')
})

// —— 中文口语金额 "X块Y"（47块5 = 47.5）——
// "旅游"属娱乐分类且优先级高于交通，故"旅游高速费"按"旅游"归娱乐；
// 单独说"高速费"才归交通。
test('旅游高速费47块5 → 娱乐 -47.5（旅游优先于交通）', () => {
  const r = parseExpense('旅游高速费47块5')
  assert.equal(r.amount, -47.5)
  assert.equal(r.category, '娱乐')
})

test('高速费47块5 → 交通 -47.5', () => {
  const r = parseExpense('高速费47块5')
  assert.equal(r.amount, -47.5)
  assert.equal(r.category, '交通')
})

// —— 边界：仅有英文消费词无金额 → null ——
test('仅"taxi"无金额 → null', () => {
  assert.equal(parseExpense('taxi'), null)
})

test('仅"by taxi"无金额 → null', () => {
  assert.equal(parseExpense('by taxi'), null)
})

// —— 通用兜底：白名单外的新品类词 + 数字（无单位） ——
// 场景：用户输入"谷子20""手办15"等没在已知动作词里的品类词。
// 修复前 regexExpense=null → 模型幻觉"已记账"但代码没 doAdd；
// 修复后启发式兜底 → 真记账，归"其他"分类。
test('谷子20 → 其他 -20（防模型幻觉）', () => {
  const r = parseExpense('谷子20')
  assert.equal(r.amount, -20)
  assert.equal(r.category, '其他')
})

test('手办15 → 其他 -15', () => {
  const r = parseExpense('手办15')
  assert.equal(r.amount, -15)
  assert.equal(r.category, '其他')
})

test('海报8 → 其他 -8', () => {
  const r = parseExpense('海报8')
  assert.equal(r.amount, -8)
  assert.equal(r.category, '其他')
})

test('立牌5 → 其他 -5', () => {
  const r = parseExpense('立牌5')
  assert.equal(r.amount, -5)
  assert.equal(r.category, '其他')
})

test('谷子 20.5（带空格+小数）→ 其他 -20.5', () => {
  const r = parseExpense('谷子 20.5')
  assert.equal(r.amount, -20.5)
  assert.equal(r.category, '其他')
})

test('买了个徽章12 → 购物 -12（"买"命中主路径）', () => {
  const r = parseExpense('买了个徽章12')
  assert.equal(r.amount, -12)
  // "买"在 INTENT_KEYS 里，走主路径命中购物类
  assert.equal(r.category, '购物')
})

// —— 兜底边界：非消费数字不能误中 ——
test('我今年25岁 → null（"岁"排除）', () => {
  assert.equal(parseExpense('我今年25岁'), null)
})

test('今天3号 → null（"号"排除）', () => {
  assert.equal(parseExpense('今天3号'), null)
})

test('8月15日 → null（"月"/"日"排除）', () => {
  assert.equal(parseExpense('8月15日'), null)
})

test('第2名 → null（"第"排除）', () => {
  assert.equal(parseExpense('第2名'), null)
})

test('iphone 12 → 其他 -12（英文输入已放宽；误中由用户撤回）', () => {
  // 注：放宽兜底后，iphone 12 也会被识别为记账。这是已知副作用——
  // 用户可能误中（"iphone 12"里的 12 是型号不是金额），但代价只是手动撤回一下。
  // 收紧规则会伤及"niunai100"等合法拼音场景，得不偿失。
  const r = parseExpense('iphone 12')
  assert.equal(r.amount, -12)
  assert.equal(r.category, '其他')
})

test('5kg米 → null（"kg"排除）', () => {
  assert.equal(parseExpense('5kg米'), null)
})

test('3楼 → null（"楼"排除）', () => {
  assert.equal(parseExpense('3楼'), null)
})

// —— 兜底放宽：拼音/英文输入场景（"newnew100"=拼音/英文混合） ——
// 之前要求"开头是中文"，导致拼音输入完全识别不了。放宽到"中文或字母"。
test('newnew100 → 其他 -100（拼音/英文场景）', () => {
  const r = parseExpense('newnew100')
  assert.equal(r.amount, -100)
  assert.equal(r.category, '其他')
})

test('niunai100（牛奶拼音）→ 其他 -100', () => {
  const r = parseExpense('niunai100')
  assert.equal(r.amount, -100)
  assert.equal(r.category, '其他')
})

test('mianbao50（面包拼音）→ 其他 -50', () => {
  const r = parseExpense('mianbao50')
  assert.equal(r.amount, -50)
  assert.equal(r.category, '其他')
})

test('test 100 → 其他 -100（英文输入）', () => {
  const r = parseExpense('test 100')
  assert.equal(r.amount, -100)
  assert.equal(r.category, '其他')
})

// —— 兜底边界：过短或纯符号仍不能误中 ——
test('a1 → null（长度 < 3）', () => {
  assert.equal(parseExpense('a1'), null)
})

test('!!100 → null（开头非中文/字母）', () => {
  assert.equal(parseExpense('!!100'), null)
})

test('123 → null（纯数字）', () => {
  assert.equal(parseExpense('123'), null)
})

// —— 多轮上下文复用：肯定词应答上一轮查询 ——
// 场景：上一轮"这个月花了多少"返回反问"要查吗"，用户回"对"——应复用上次 query
test('parseQuery "对" + ctx.query={type:"month"} → 复用 month', () => {
  const r = parseQuery('对', { query: { type: 'month', month: 'this' } })
  assert.equal(r.type, 'month')
})

test('parseQuery "嗯" + ctx.query={type:"category"} → 复用 category', () => {
  const r = parseQuery('嗯', { query: { type: 'category', category: '餐饮' } })
  assert.equal(r.type, 'category')
  assert.equal(r.category, '餐饮')
})

test('parseQuery "yes" + ctx.query={type:"range"} → 复用 range', () => {
  const ctx = { query: { type: 'range', range: { mode: 'lastN', days: 7 }, rangeLabel: '最近 7 天' } }
  const r = parseQuery('yes', ctx)
  assert.equal(r.type, 'range')
  assert.equal(r.range.days, 7)
})

test('parseQuery "对" 但无 ctx → null（不能凭空返回查询）', () => {
  assert.equal(parseQuery('对', null), null)
})

test('parseQuery "对" + ctx 但 ctx.query 为空 → null', () => {
  assert.equal(parseQuery('对', { query: null }), null)
})

test('parseQuery "不对" + ctx → null（否定词 → 取消查询）', () => {
  assert.equal(parseQuery('不对', { query: { type: 'month' } }), null)
})

test('parseQuery "好的" + ctx → 复用查询', () => {
  const r = parseQuery('好的', { query: { type: 'month' } })
  assert.equal(r.type, 'month')
})

test('parseQuery "对呀" → null（不在白名单）', () => {
  // 太口语化的"对呀"暂不覆盖，避免误识别
  assert.equal(parseQuery('对呀', { query: { type: 'month' } }), null)
})

// —— 原 parseQuery 行为不回归 ——
test('parseQuery "这个月花了多少" → month', () => {
  const r = parseQuery('这个月花了多少')
  assert.equal(r.type, 'month')
})

test('parseQuery "餐饮花了多少" → category', () => {
  const r = parseQuery('餐饮花了多少')
  assert.equal(r.type, 'category')
  assert.equal(r.category, '餐饮')
})

// —— 分类 + 明细组合：必须走 recent 带 category（不要走 category 统计） ——
// 场景：用户说"餐饮明细"期望看餐饮的记录列表，旧的会被错判成"餐饮花了多少"。
test('parseQuery "餐饮明细" → recent + category=餐饮', () => {
  const r = parseQuery('餐饮明细')
  assert.equal(r.type, 'recent')
  assert.equal(r.category, '餐饮')
})

test('parseQuery "交通最近" → recent + category=交通', () => {
  const r = parseQuery('交通最近')
  assert.equal(r.type, 'recent')
  assert.equal(r.category, '交通')
})

test('parseQuery "购物记录" → recent + category=购物', () => {
  const r = parseQuery('购物记录')
  assert.equal(r.type, 'recent')
  assert.equal(r.category, '购物')
})

test('parseQuery "最近记的"（无分类）→ recent only', () => {
  const r = parseQuery('最近记的')
  assert.equal(r.type, 'recent')
  assert.equal(r.category, undefined)
})

test('parseQuery "明细"（无分类）→ recent only', () => {
  const r = parseQuery('明细')
  assert.equal(r.type, 'recent')
  assert.equal(r.category, undefined)
})

test('parseQuery "餐饮花了多少" → category（不是 recent）', () => {
  const r = parseQuery('餐饮花了多少')
  assert.equal(r.type, 'category')
})
// ============================================================
// Fix #2: 中文数字金额
// ============================================================
test('中文数字"午饭五十" → 餐饮 -50', () => {
  const r = parseExpense('午饭五十')
  assert.equal(r.amount, -50)
  assert.equal(r.category, '餐饮')
})

test('中文数字"午饭五十块" → 餐饮 -50', () => {
  const r = parseExpense('午饭五十块')
  assert.equal(r.amount, -50)
  assert.equal(r.category, '餐饮')
})

test('中文数字"午饭三十多" → 餐饮 -30', () => {
  const r = parseExpense('午饭三十多')
  assert.equal(r.amount, -30)
  assert.equal(r.category, '餐饮')
})

test('中文数字"打车二十五" → 交通 -25', () => {
  const r = parseExpense('打车二十五')
  assert.equal(r.amount, -25)
  assert.equal(r.category, '交通')
})

test('中文数字"午饭一百五" → 餐饮 -150', () => {
  const r = parseExpense('午饭一百五')
  assert.equal(r.amount, -150)
})

test('中文数字"午饭两百" → 餐饮 -200', () => {
  const r = parseExpense('午饭两百')
  assert.equal(r.amount, -200)
})

test('中文数字"午饭十五六块" → 取较长段 十六 -16', () => {
  const r = parseExpense('午饭十五六块')
  assert.equal(r.amount, -16)
})

// ============================================================
// Fix #3: 英文/品牌别名 → 餐饮
// ============================================================
test('starbucks 50 → 餐饮 -50', () => {
  const r = parseExpense('starbucks 50')
  assert.equal(r.amount, -50)
  assert.equal(r.category, '餐饮')
})

test('KFC 88 → 餐饮 -88', () => {
  const r = parseExpense('KFC 88')
  assert.equal(r.amount, -88)
  assert.equal(r.category, '餐饮')
})

test('麦当劳 35 → 餐饮 -35', () => {
  const r = parseExpense('麦当劳 35')
  assert.equal(r.amount, -35)
  assert.equal(r.category, '餐饮')
})

test('星巴克 45 → 餐饮 -45', () => {
  const r = parseExpense('星巴克 45')
  assert.equal(r.amount, -45)
  assert.equal(r.category, '餐饮')
})

test('瑞幸 28 → 餐饮 -28', () => {
  const r = parseExpense('瑞幸 28')
  assert.equal(r.amount, -28)
  assert.equal(r.category, '餐饮')
})

// ============================================================
// Fix #4: 撤回关键词扩展
// ============================================================
const { parseUndo } = require('../parseExpense')

test('parseUndo "记错了" → true', () => {
  assert.equal(parseUndo('记错了'), true)
})

test('parseUndo "弄错了" → true', () => {
  assert.equal(parseUndo('弄错了'), true)
})

test('parseUndo "刚才那笔不对" → true', () => {
  assert.equal(parseUndo('刚才那笔不对'), true)
})

test('parseUndo "帮我撤了" → true', () => {
  assert.equal(parseUndo('帮我撤了'), true)
})

test('parseUndo "今天天气不错" → false', () => {
  assert.equal(parseUndo('今天天气不错'), false)
})

// ============================================================
// Fix #1: 过去日期识别
// ============================================================
const { parseDateHint } = require('../parseExpense')

test('parseDateHint "昨天" → 有效日期', () => {
  const r = parseDateHint('昨天')
  assert.match(r, /^\d{4}-\d{2}-\d{2}$/)
})

test('parseDateHint "前天" → 有效日期', () => {
  const r = parseDateHint('前天')
  assert.match(r, /^\d{4}-\d{2}-\d{2}$/)
})

test('parseDateHint "大前天" → 有效日期', () => {
  const r = parseDateHint('大前天')
  assert.match(r, /^\d{4}-\d{2}-\d{2}$/)
})

test('parseDateHint "3天前" → 有效日期', () => {
  const r = parseDateHint('3天前')
  assert.match(r, /^\d{4}-\d{2}-\d{2}$/)
})

test('parseDateHint "上个月" → 有效日期（边界修复：原返回新月首日）', () => {
  const r = parseDateHint('上个月')
  assert.match(r, /^\d{4}-\d{2}-\d{2}$/)
})

test('parseDateHint "午饭38" → null（无日期提示）', () => {
  assert.equal(parseDateHint('午饭38'), null)
})

// 集成测试：date 字段挂载
test('parseExpense "昨天午饭38" → 含 _date 字段', () => {
  const r = parseExpense('昨天午饭38')
  assert.equal(r.amount, -38)
  assert.equal(r.category, '餐饮')
  assert.match(r._date, /^\d{4}-\d{2}-\d{2}$/)
})

test('parseExpense "前天打车25" → 含 _date', () => {
  const r = parseExpense('前天打车25')
  assert.equal(r.amount, -25)
  assert.equal(r.category, '交通')
  assert.match(r._date, /^\d{4}-\d{2}-\d{2}$/)
})

test('parseExpense "午饭38"（无日期）→ _date null', () => {
  const r = parseExpense('午饭38')
  assert.equal(r._date, null)
})
