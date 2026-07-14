Page({
  data: {
    summary: { day: { income: 0, expense: 0 }, month: { income: 0, expense: 0 } },
    recent: [],
    loading: true,
    _fetching: false, // 防重复调用
  },

  onShow() {
    this.loadData()
  },

  loadData() {
    if (this.data._fetching) return
    this.setData({ loading: true, _fetching: true })

    // 汇总（先发）
    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: { action: 'summary' },
    }).then((res) => {
      if (res.result && res.result.success) {
        this.setData({ summary: res.result })
      }
    }).catch((err) => {
      console.error('summary failed', err)
    }).then(() => {
      // 拉完汇总再拉列表（串行，用 .then 传递结果，不能用 .finally——finally 会吞掉返回值）
      return wx.cloud.callFunction({
        name: 'miaojiRecord',
        data: { action: 'list', payload: { limit: 5 } },
      })
    }).then((res) => {
      if (res && res.result && res.result.success) {
        const recent = (res.result.list || []).map((r) => ({
          _id: r._id,
          amount: r.amount,
          type: r.type,
          category: r.category,
          note: r.note,
          time: this.formatTime(r.createdAt),
        }))
        this.setData({ recent })
      }
    }).catch((err) => {
      console.error('list failed', err)
    }).finally(() => {
      this.setData({ loading: false, _fetching: false })
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
