// 旅游记录 - 新建/编辑旅程页
Page({
  data: {
    isEdit: false,
    tripId: '',
    title: '',
    startDate: '',
    endDate: '',
    location: null,
    cover: '',
    summary: '',
  },

  onLoad(options) {
    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    this.setData({
      startDate: dateStr,
      endDate: dateStr,
    })

    // 编辑模式
    if (options.tripId) {
      this.setData({ isEdit: true, tripId: options.tripId })
      wx.setNavigationBarTitle({ title: '编辑旅程' })
      this.loadTrip(options.tripId)
    }
  },

  loadTrip(tripId) {
    wx.cloud.callFunction({
      name: 'travelRecord',
      data: { action: 'getTrip', tripId },
    }).then((res) => {
      if (res.result && res.result.success) {
        const t = res.result.trip
        this.setData({
          title: t.title,
          startDate: t.startDate,
          endDate: t.endDate,
          location: t.location ? { name: t.location } : null,
          cover: t.cover || '',
          summary: t.summary || '',
        })
      }
    })
  },

  // 地点选择
  chooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          location: {
            name: res.name,
            address: res.address,
            latitude: res.latitude,
            longitude: res.longitude,
          },
        })
      },
      fail: (err) => {
        if (err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '获取位置失败', icon: 'none' })
        }
      },
    })
  },

  // 查看地图
  viewLocation() {
    const loc = this.data.location
    if (!loc) return

    if (loc.latitude && loc.longitude) {
      wx.openLocation({
        latitude: loc.latitude,
        longitude: loc.longitude,
        name: loc.name || '',
        address: loc.address || '',
        scale: 15,
      })
    } else if (loc.name) {
      wx.showLoading({ title: '正在获取坐标…' })
      wx.cloud.callFunction({
        name: 'travelRecord',
        data: { action: 'geocode', address: loc.name },
      }).then((res) => {
        wx.hideLoading()
        if (res.result && res.result.success) {
          this.setData({
            location: {
              name: loc.name,
              address: res.result.address || '',
              latitude: res.result.latitude,
              longitude: res.result.longitude,
            },
          })
          wx.openLocation({
            latitude: res.result.latitude,
            longitude: res.result.longitude,
            name: loc.name,
            scale: 15,
          })
        } else {
          wx.showToast({ title: '未找到该地点坐标', icon: 'none' })
        }
      }).catch(() => {
        wx.hideLoading()
        wx.showToast({ title: '获取坐标失败', icon: 'none' })
      })
    }
  },

  // 封面
  chooseCover() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles[0]
        this.setData({ cover: file.tempFilePath })
      },
    })
  },

  removeCover() {
    this.setData({ cover: '' })
  },

  // 表单输入
  onTitleInput(e) { this.setData({ title: e.detail.value }) },
  onStartDateChange(e) { this.setData({ startDate: e.detail.value }) },
  onEndDateChange(e) { this.setData({ endDate: e.detail.value }) },
  onSummaryInput(e) { this.setData({ summary: e.detail.value }) },

  // 保存
  save() {
    if (!this.data.title || !this.data.startDate || !this.data.endDate) {
      wx.showToast({ title: '请填写标题和日期', icon: 'none' })
      return
    }

    const data = {
      title: this.data.title,
      startDate: this.data.startDate,
      endDate: this.data.endDate,
      location: this.data.location ? this.data.location.name : '',
      summary: this.data.summary,
    }

    wx.showLoading({ title: '保存中…' })

    // 上传封面
    const coverUpload = this.data.cover && this.data.cover.startsWith('http')
      ? Promise.resolve(this.data.cover)
      : this.data.cover
        ? wx.cloud.uploadFile({
            cloudPath: `travel/cover_${Date.now()}.jpg`,
            filePath: this.data.cover,
          }).then((r) => r.fileID)
        : Promise.resolve(this.data.cover)

    coverUpload.then((coverUrl) => {
      if (coverUrl) data.cover = coverUrl

      const action = this.data.isEdit ? 'updateTrip' : 'createTrip'
      if (this.data.isEdit) data.tripId = this.data.tripId

      return wx.cloud.callFunction({
        name: 'travelRecord',
        data: { action, ...data },
      })
    }).then((res) => {
      wx.hideLoading()
      if (res.result && res.result.success) {
        wx.showToast({ title: '已保存' })
        setTimeout(() => wx.navigateBack(), 500)
      } else {
        wx.showToast({ title: res.result.error || '保存失败', icon: 'none' })
      }
    }).catch((err) => {
      wx.hideLoading()
      console.error('save trip error', err)
      wx.showToast({ title: '保存失败', icon: 'none' })
    })
  },
})