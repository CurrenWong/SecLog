// pages/profile/profile.js
const app = getApp()

Page({
  data: {
    avatarUrl: '',      // 头像（空则用默认）
    nickName: '',       // 昵称
    openid: '',
    unionid: '',
    summary: { month: { income: 0, expense: 0 }, count: 0 },
    loading: true,
    _fetching: false,
  },

  onShow() {
    this.syncFromCache()
    this.loadSummary()
  },

  // 从本地缓存同步身份（静默登录已写好）
  syncFromCache() {
    const info = wx.getStorageSync('userInfo') || app.globalData.userInfo || {}
    this.setData({
      avatarUrl: info.avatarUrl || '',
      nickName: info.nickName || '',
      openid: info.openid || '',
      unionid: info.unionid || '',
    })
  },

  // 本月汇总 + 记账笔数
  loadSummary() {
    if (this.data._fetching) return
    this.setData({ _fetching: true })
    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: { action: 'stats', payload: { type: 'month' } },
    }).then((res) => {
      if (res.result && res.result.success) {
        const incomeT = res.result.incomeTotal || 0
        const expenseT = Math.abs(res.result.expenseTotal || 0)
        this.setData({
          summary: {
            month: { income: incomeT, expense: expenseT },
            monthIncomeText: incomeT.toFixed(2),
            monthExpenseText: expenseT.toFixed(2),
            count: res.result.count || 0,
          },
        })
      }
    }).catch((err) => {
      console.error('stats failed', err)
    }).finally(() => {
      this.setData({ loading: false, _fetching: false })
    })
  },

  // 头像选择（新版 chooseAvatar，非弹窗授权）
  onChooseAvatar(e) {
    const { avatarUrl } = e.detail
    if (!avatarUrl) return
    wx.showLoading({ title: '上传中' })
    const openid = (wx.getStorageSync('userInfo') || {}).openid || 'anon'
    // chooseAvatar 返回 wxfile:// 临时路径，需上传云存储拿到永久 fileID 才能持久显示
    wx.cloud.uploadFile({
      cloudPath: `avatars/${openid}.png`,
      filePath: avatarUrl,
    }).then((up) => {
      this.setData({ avatarUrl: up.fileID })
      this.saveProfile({ avatarUrl: up.fileID })
      wx.hideLoading()
    }).catch((err) => {
      console.error('upload avatar failed', err)
      wx.hideLoading()
      wx.showToast({ title: '上传失败', icon: 'none' })
    })
  },

  // 昵称输入（type="nickname" 走微信昵称填写能力）
  onNickNameInput(e) {
    this.setData({ nickName: e.detail.value })
  },

  onNickNameBlur(e) {
    const nickName = (e.detail.value || '').trim()
    if (nickName) {
      this.setData({ nickName })
      this.saveProfile({ nickName })
    }
  },

  // 写回云函数 + 本地缓存
  saveProfile(patch) {
    const info = Object.assign({}, wx.getStorageSync('userInfo') || {}, patch)
    wx.setStorageSync('userInfo', info)
    app.globalData.userInfo = info
    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: { action: 'updateProfile', payload: patch },
    }).then((res) => {
      if (!(res.result && res.result.success)) {
        const code = (res.result && res.result.code) || 'UNKNOWN'
        const msg = (res.result && res.result.message) || ''
        wx.showToast({ title: '保存失败:' + code, icon: 'none' })
        console.error('updateProfile failed', code, msg)
      } else {
        wx.showToast({ title: '已保存', icon: 'success' })
      }
    }).catch((err) => {
      console.error('updateProfile failed', err)
      wx.showToast({ title: '保存失败:NET', icon: 'none' })
    })
  },

  // 退出登录（清本地，重进自动重新静默登录）
  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '将清除本地账号缓存，重进小程序会自动重新登录（数据不会丢失）。',
      success: (r) => {
        if (r.confirm) {
          app.logout()
          this.setData({ avatarUrl: '', nickName: '', openid: '', unionid: '' })
          wx.showToast({ title: '已退出', icon: 'success' })
        }
      },
    })
  },

  // 关于
  onAbout() {
    wx.showModal({
      title: '秒记账',
      content: '说话即记账 · AI 帮你管钱\n\n数据按微信账号隔离，仅你可见。',
      showCancel: false,
    })
  },

  onPullDownRefresh() {
    this.loadSummary()
    wx.stopPullDownRefresh()
  },
})
