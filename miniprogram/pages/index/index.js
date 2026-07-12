Page({
  data: {
    summary: { day: { income: 0, expense: 0 }, month: { income: 0, expense: 0 } },
    recent: [],
    loading: true,
  },

  onShow() {
    this.loadData()
  },

  loadData() {
    this.setData({ loading: true })
    const db = wx.cloud.database ? null : null // 占位，实际走云函数
    // 汇总
    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: { action: 'summary' },
    }).then((res) => {
      if (res.result && res.result.success) {
        this.setData({ summary: res.result })
      }
    }).catch((err) => {
      console.error('summary failed', err)
    })

    // 最近记录
    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: { action: 'list', payload: { limit: 5 } },
    }).then((res) => {
      if (res.result && res.result.success) {
        const recent = (res.result.list || []).map((r) => ({
          _id: r._id,
          amount: r.amount,
          type: r.type,
          category: r.category,
          note: r.note,
          // createdAt 在服务端是 serverDate，客户端拿到的是字符串或 Date
          time: this.formatTime(r.createdAt),
        }))
        this.setData({ recent, loading: false })
      } else {
        this.setData({ loading: false })
      }
    }).catch((err) => {
      console.error('list failed', err)
      this.setData({ loading: false })
    })
  },

  formatTime(ts) {
    if (!ts) return ''
    let d
    if (typeof ts === 'string') {
      d = new Date(ts)
    } else if (ts instanceof Date) {
      d = ts
    } else if (ts.$date) {
      d = new Date(ts.$date)
    } else {
      return ''
    }
    if (isNaN(d.getTime())) return ''
    const pad = (n) => (n < 10 ? '0' + n : '' + n)
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  },

  goChat() {
    wx.navigateTo({ url: '/pages/chatBot/chatBot' })
  },

  goGuide() {
    wx.navigateTo({ url: '/pages/guide/guide' })
  },

  onPullDownRefresh() {
    this.loadData()
    wx.stopPullDownRefresh()
  },
})
