// 旅游记录 - 旅程列表页
const app = getApp()

Page({
  data: {
    trips: [],
    loading: true,
  },

  onShow() {
    this.loadTrips()
  },

  onPullDownRefresh() {
    this.loadTrips().then(() => {
      wx.stopPullDownRefresh()
    })
  },

  loadTrips() {
    this.setData({ loading: true })
    return wx.cloud.callFunction({
      name: 'travelRecord',
      data: { action: 'listTrips', page: 1, limit: 50 },
    }).then((res) => {
      if (res.result && res.result.success) {
        this.setData({ trips: res.result.trips || [] })
      }
    }).catch((err) => {
      console.error('loadTrips failed', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }).finally(() => {
      this.setData({ loading: false })
    })
  },

  // 点击旅程卡片进入详情
  goTrip(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/tripDetail/tripDetail?tripId=${id}` })
  },

  // 新建旅程
  goNewTrip() {
    wx.navigateTo({ url: '/pages/tripEdit/tripEdit' })
  },

  // 快速记录（语音/文字 → 自动匹配旅程）
  goQuickRecord() {
    wx.navigateTo({ url: '/pages/journalEdit/journalEdit?mode=quick' })
  },
})