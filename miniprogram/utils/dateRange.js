// utils/dateRange.js
// 时间范围工具函数：与 miaojiRecord 云函数 stats 接口的"本月"口径完全一致。
//
// 核心约定（与 cloudfunctions/miaojiRecord/index.js case 'stats' 的 month='this' 分支对齐）：
//   - 本月 = [本月 1 号 00:00 UTC, 现在]
//   - 起算点为本月 1 号 0 点 0 分 0 秒（不含毫秒边界），不是过去 30 天
//
// "最近 30 天"和"本月"是两个语义截然不同的口径：
//   - 30 天：固定滚动窗口（today - 30）
//   - 本月：自然月（1 号到今天）
// 在月份交界处两者会显著不一致，导致用户对账混乱。
// 详见 MIAOJI_TODO.md「修复：最近一个月明细口径不一致」。

/**
 * 当前自然月内、起算日（本月 1 号）到今天的天数。
 * 用于云函数 list 接口的 days 参数（days = 本月起算 → 今天, 含两端共 N 天）。
 *
 * 边界 case：
 *   - 月初（1 号）：返回 1
 *   - 月末（31 号）：返回 31
 *   - 跨月（1 月 1 日）：上月已结束，但本月从 1/1 开始 → 仅 1
 *
 * @param {Date} [now] 可选 now，便于单测 mock 时间
 * @returns {number} 月初到今天的天数（≥1）
 */
function computeCurrentMonthDays(now) {
  const n = now || new Date()
  const start = new Date(n.getFullYear(), n.getMonth(), 1)
  // (n - start) 是距月初的毫秒；+1 表示含今天，与「查账页面本月」口径一致
  return Math.floor((n.getTime() - start.getTime()) / 86400000) + 1
}

module.exports = { computeCurrentMonthDays }
