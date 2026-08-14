Page({
  data: {
    summary: { day: { income: 0, expense: 0 }, month: { income: 0, expense: 0 } },
    recent: [],
    loading: true,
    avatarUrl: '',
    versionText: '',
    _fetching: false, // 防重复调用
  },

  onShow() {
    this.loadData()
    // 同步头像（个人中心改了后回到首页实时更新）
    const info = wx.getStorageSync('userInfo') || {}
    this.setData({ avatarUrl: info.avatarUrl || '' })
    // 展示版本号，便于真机扫码核验体验版
    const app = getApp()
    if (app && app.globalData) {
      this.setData({ versionText: app.globalData.version || '' })
    }
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
        const s = res.result
        this.setData({
          summary: {
            day: { income: s.day.income, expense: s.day.expense },
            month: { income: s.month.income, expense: s.month.expense },
            dayIncomeText: (s.day.income || 0).toFixed(2),
            dayExpenseText: (s.day.expense || 0).toFixed(2),
            monthIncomeText: (s.month.income || 0).toFixed(2),
            monthExpenseText: (s.month.expense || 0).toFixed(2),
          },
        })
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
          amountText: (r.amount || 0).toFixed(2),
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

  goRecords() {
    wx.navigateTo({ url: '/pages/records/records' })
  },

  goGuide() {
    wx.navigateTo({ url: '/pages/guide/guide' })
  },

  goTravel() {
    wx.navigateTo({ url: '/pages/travelList/travelList' })
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' })
  },

  onPullDownRefresh() {
    this.loadData()
    wx.stopPullDownRefresh()
  },
})
