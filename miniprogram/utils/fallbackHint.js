// utils/fallbackHint.js
// 模型识别失败时的反问生成器：基于正则 hint 给明确指引，不调闲聊模型（避免无上下文答非所问）。
// 优先级：undo > 记账（regexExpense）> 查询（queryHint）> 兜底。
// 仅在 chatBot `if (!decision)` 分支被调用；不影响成功路径。

/**
 * @param {{undoHint?: boolean, regexExpense?: {amount:number, category:string, note?:string}, queryHint?: {type:string, category?:string, rangeLabel?:string, range?:any}, text?: string}} hints
 */
function buildFallbackHint({ regexExpense, queryHint, undoHint } = {}) {
  if (undoHint) {
    return ' 要撤回刚才那笔吗？回复"撤回"我帮你删~'
  }
  if (regexExpense) {
    const sign = regexExpense.amount < 0 ? '-' : '+'
    const notePart = regexExpense.note ? '（' + regexExpense.note + '）' : ''
    return ' 你想记「' + regexExpense.category + '」' + sign + '¥' + Math.abs(regexExpense.amount) + notePart + '吗？回复确认或更正金额/类别~'
  }
  if (queryHint) {
    if (queryHint.type === 'day') return ' 要查今天花了多少吗？'
    if (queryHint.type === 'category') return ' 要查「' + queryHint.category + '」花了多少吗？'
    if (queryHint.type === 'recent') return ' 要看最近的记账明细吗？'
    if (queryHint.type === 'range') {
      if (queryHint.rangeLabel) return ' 要查' + queryHint.rangeLabel + '的开支吗？'
      const range = queryHint.range || {}
      if (range.mode === 'year') return ' 要查' + range.year + '年的开支吗？'
      if (range.mode === 'lastN') return ' 要查最近' + range.days + '天的开支吗？'
      if (range.mode === 'between') return ' 要查' + range.from + ' ~ ' + range.to + '的开支吗？'
    }
    return ' 要查这个月的总开销吗？'
  }
  // 兜底：likelyNonChat=true 但 hint 全空（一般是预判边界，给用户纠错机会）
  return ' 没太明白你的意思~ 比如「午饭花了38」记一笔，或「这个月花了多少」查账目，换一种说法试试？'
}

// "全空白"兜底：likelyNonChat=false（正则啥也没命中） + 模型也失败/沉默
// 给用户一份完整的可用意图清单，避免空白回复。
// 跟 buildFallbackHint 区别：后者有 hint 时给针对性反问；前者无任何 hint 时给"我能帮你什么"。
function buildBlankFallbackHint() {
  return (
    ' 没太明白你说的~ 我是秒记，能帮你：\n' +
    '· 记账：「午饭 38」「滴滴 17.7」「买菜 60」\n' +
    '· 查账：「这个月花了多少」「餐饮明细」「最近记的」\n' +
    '· 撤回：直接说「撤回」\n' +
    '换个说法试试？'
  )
}

module.exports = { buildFallbackHint, buildBlankFallbackHint }
