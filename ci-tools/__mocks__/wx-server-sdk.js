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
    if (v && typeof v === 'object' && v.$gte !== undefined) return row[k] >= v.$gte
    return row[k] === v
  })
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
  }
  return q
}

const db = {
  collection() {
    return {
      async add({ data }) {
        const _id = 'id_' + Math.random().toString(36).slice(2, 9)
        // data 里已有 createdAt（来自云函数 db.serverDate()），不覆盖
        store.push(Object.assign({ _id }, data))
        return { _id }
      },
      where(cond) { return makeQuery().where(cond) },
      orderBy(f, d) { return makeQuery().orderBy(f, d) },
      limit(n) { return makeQuery().limit(n) },
      get() { return makeQuery().get() },
      remove() { return makeQuery().remove() },
    }
  },
  // 模拟云函数 db.serverDate()：返回递增时间戳（seq 在模块级），
  // 既保证 summary 的 createdAt >= startOfDay 比较成立，又保证 list 倒序稳定
  serverDate() { return new Date(Date.now() + seq++) },
  command: { gte: (v) => ({ $gte: v }) },
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
