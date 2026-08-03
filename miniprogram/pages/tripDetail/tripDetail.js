// 旅游记录 - 旅程详情页（时间线）
Page({
  data: {
    trip: {},
    journals: [],
    loading: true,
    tripId: '',
  },

  onLoad(options) {
    this.setData({ tripId: options.tripId })
  },

  onShow() {
    if (this.data.tripId) {
      this.loadTrip()
    }
  },

  onPullDownRefresh() {
    if (this.data.tripId) {
      this.loadTrip().then(() => {
        wx.stopPullDownRefresh()
      })
    }
  },

  loadTrip() {
    this.setData({ loading: true })
    return wx.cloud.callFunction({
      name: 'travelRecord',
      data: { action: 'getTrip', tripId: this.data.tripId },
    }).then((res) => {
      if (res.result && res.result.success) {
        this.setData({
          trip: res.result.trip,
          journals: res.result.entries || [],
        })
        wx.setNavigationBarTitle({ title: res.result.trip.title || '旅途详情' })
      }
    }).catch((err) => {
      console.error('loadTrip failed', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }).finally(() => {
      this.setData({ loading: false })
    })
  },

  // 写日记
  addJournal() {
    wx.navigateTo({
      url: `/pages/journalEdit/journalEdit?tripId=${this.data.tripId}&mode=add`,
    })
  },

  // 编辑日记
  editJournal(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/journalEdit/journalEdit?tripId=${this.data.tripId}&journalId=${id}&mode=edit`,
    })
  },

  // 编辑旅程
  editTrip() {
    wx.navigateTo({
      url: `/pages/tripEdit/tripEdit?tripId=${this.data.tripId}`,
    })
  },

  // 删除旅程
  deleteTrip() {
    wx.showModal({
      title: '确认删除',
      content: '删除后所有日记也会一并删除，不可恢复',
      success: (res) => {
        if (res.confirm) {
          wx.cloud.callFunction({
            name: 'travelRecord',
            data: { action: 'deleteTrip', tripId: this.data.tripId },
          }).then((res) => {
            if (res.result && res.result.success) {
              wx.showToast({ title: '已删除' })
              wx.navigateBack()
            }
          })
        }
      },
    })
  },

  // 预览照片
  previewPhoto(e) {
    const url = e.currentTarget.dataset.url
    wx.previewImage({ urls: [url] })
  },
})