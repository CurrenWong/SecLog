// __mocks__/wx-server-sdk.js
// miaojiRecord 云函数在测试里 require('wx-server-sdk')，这里提供可控的 mock 实现。
// 测试通过 cloud.__reset(store, ctx) 控制内存"数据库"与 OPENID 上下文。

// 模块级单例 store：add / list / delete 都操作它，保证同一份数据
let store = []
let ctx = { OPENID: undefined }
let seq = 0 // 递增时间戳序号，保证 orderBy('createdAt','desc') 排序稳定

function matchWhere(row, cond) {
  return Object.keys(cond).every((k) => {
    const v = cond[k]
    if (v && typeof v === 'object') {
      // 同一字段上的所有 $ 前缀条件（含 $gte/$lt/$gt/$lte/$eq + $and/$or 嵌套）都参与 AND 检查
      // 把 v 自己作为子条件（携带顶层 $gte/$lt 等），再把 $and/$or 里的子条件也并入
      const subs = [v]
      if (v.$and) subs.push(...v.$and)
      if (v.$or) {
        // OR 语义复杂：subs 整体要求"任一为真"
        return subs.some((s) => checkRange(row[k], s))
      }
      return subs.every((s) => checkRange(row[k], s))
    }
    return row[k] === v
  })
}

function checkRange(actual, sub) {
  if (sub.$gte !== undefined && !(actual >= sub.$gte)) return false
  if (sub.$lt !== undefined && !(actual < sub.$lt)) return false
  if (sub.$gt !== undefined && !(actual > sub.$gt)) return false
  if (sub.$lte !== undefined && !(actual <= sub.$lte)) return false
  if (sub.$eq !== undefined && actual !== sub.$eq) return false
  return true
}

function makeQuery() {
  const state = { wheres: [], orders: [], limitN: 50 }
  const q = {
    where(cond) { state.wheres.push(cond); return q },
    orderBy(field, dir) { state.orders.push([field, dir]); return q },
    limit(n) { state.limitN = n; return q },
    async get() {
      let rows = store.slice()
      for (const w of state.wheres) rows = rows.filter((r) => matchWhere(r, w))
      for (const [field, dir] of state.orders) {
        rows.sort((a, b) => {
          const av = a[field], bv = b[field]
          if (av instanceof Date && bv instanceof Date) return dir === 'desc' ? bv - av : av - bv
          return dir === 'desc' ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1)
        })
      }
      return { data: rows.slice(0, state.limitN) }
    },
    async remove() {
      let rows = store.slice()
      for (const w of state.wheres) rows = rows.filter((r) => matchWhere(r, w))
      const before = store.length
      for (const r of rows) {
        const i = store.indexOf(r)
        if (i >= 0) store.splice(i, 1)
      }
      return { stats: { removed: before - store.length } }
    },
    async update({ data }) {
      let rows = store.slice()
      for (const w of state.wheres) rows = rows.filter((r) => matchWhere(r, w))
      let updated = 0
      for (const r of rows) {
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && v.$inc !== undefined) {
            r[k] = (r[k] || 0) + v.$inc
          } else {
            r[k] = v
          }
        }
        updated++
      }
      return { stats: { updated } }
    },
  }
  return q
}

// 真实 CloudBase command 对象：_.gte(v) / _.lt(v) 返回命令对象，支持链式 .and(other) / .or(other) / .lt(v) ...
// 命令对象被 .where(cond) 接收时，cond[k] 是命令对象（普通对象含 $gte/$lt 字段）
// 实现策略：命令对象就是个普通对象（无 Proxy，避免 babel/jest 转译影响 Object.keys），
// 链式方法 .and() / .lt() 等都返回新的命令对象。
function makeCommand(state) {
  const cmd = {
    ...state,
    toQuery() { const out = {}; for (const k of Object.keys(this)) { if (k.startsWith('$') && k !== '$and' && k !== '$or') out[k] = this[k] }; if (this.$and) out.$and = this.$and; if (this.$or) out.$or = this.$or; return out },
    and(...more) { return makeCommand({ ...this, $and: [...(this.$and || []), ...more.map((c) => (c && c.toQuery) ? c.toQuery() : c)] }) },
    or(...more) { return makeCommand({ ...this, $or: [...(this.$or || []), ...more.map((c) => (c && c.toQuery) ? c.toQuery() : c)] }) },
  }
  // 给每个比较方法动态绑定
  for (const op of ['lt', 'gt', 'lte', 'gte', 'eq', 'neq']) {
    cmd[op] = (v) => makeCommand({ ...cmd, ['$' + op]: v })
  }
  return cmd
}

const db = {
  collection() {
    return {
      async add({ data }) {
        const _id = 'id_' + Math.random().toString(36).slice(2, 9)
        store.push(Object.assign({ _id }, data))
        return { _id }
      },
      doc(id) {
        return {
          async remove() {
            const idx = store.findIndex((r) => r._id === id)
            if (idx >= 0) store.splice(idx, 1)
            return { stats: { removed: idx >= 0 ? 1 : 0 } }
          },
          async get() {
            const row = store.find((r) => r._id === id)
            return { data: row ? [row] : [] }
          },
          async update({ data }) {
            const row = store.find((r) => r._id === id)
            if (row) {
              for (const [k, v] of Object.entries(data)) {
                if (v && typeof v === 'object' && v.$inc !== undefined) {
                  row[k] = (row[k] || 0) + v.$inc
                } else {
                  row[k] = v
                }
              }
            }
            return { stats: { updated: row ? 1 : 0 } }
          },
        }
      },
      where(cond) { return makeQuery().where(cond) },
      orderBy(f, d) { return makeQuery().orderBy(f, d) },
      limit(n) { return makeQuery().limit(n) },
      get() { return makeQuery().get() },
      remove() { return makeQuery().remove() },
      update({ data }) { return makeQuery().update({ data }) },
    }
  },
  // 模拟云函数 db.serverDate()：返回递增时间戳
  serverDate() { return new Date(Date.now() + seq++) },
  command: {
    gte: (v) => makeCommand({ $gte: v }),
    lt: (v) => makeCommand({ $lt: v }),
    gt: (v) => makeCommand({ $gt: v }),
    lte: (v) => makeCommand({ $lte: v }),
    eq: (v) => makeCommand({ $eq: v }),
    neq: (v) => makeCommand({ $neq: v }),
    inc: (v) => makeCommand({ $inc: v }),
  },
}

const cloud = {
  init() {},
  database() { return db },
  getWXContext() { return { OPENID: ctx.OPENID } },
}

module.exports = cloud
module.exports.__reset = (newStore, newCtx) => { store = newStore || []; ctx = newCtx || { OPENID: undefined } }
module.exports.__setCtx = (newCtx) => { ctx = newCtx || { OPENID: undefined } }
module.exports.__store = () => store
