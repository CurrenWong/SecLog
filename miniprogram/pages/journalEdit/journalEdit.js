// 旅游记录 - 日记编辑页（支持语音/文字/照片/地点）
const plugin = requirePlugin('WechatSI')

Page({
  data: {
    // 模式: quick=快速记录（需选旅程）, add=指定旅程, edit=编辑已有日记
    mode: 'quick',
    tripId: '',
    journalId: '',

    // 旅程选择
    trips: [],
    tripOptions: [],
    tripIndex: 0,
    tripPickerText: '请选择旅程',
    trip: {},

    // 日记内容
    date: '',
    time: '',
    day: 1,
    dayIndex: 0,
    dayOptions: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7', 'Day 8', 'Day 9', 'Day 10'],
    title: '',
    content: '',
    location: null,
    photos: [],

    // 智能输入
    aiInputText: '',
    aiLoading: false,

    // 语音
    _recording: false,
    _manager: null,
  },

  onLoad(options) {
    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const timeStr = `${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`

    this.setData({
      mode: options.mode || 'quick',
      tripId: options.tripId || '',
      journalId: options.journalId || '',
      date: dateStr,
      time: timeStr,
    })

    // 加载旅程列表（供选择）
    this.loadTrips()

    // 如果是编辑模式，加载现有日记
    if (options.journalId && options.tripId) {
      this.loadJournal(options.tripId, options.journalId)
    }

    // 初始化语音识别管理器
    this._manager = plugin.getRecordRecognitionManager()
    this._manager.onRecognize = (res) => {
      // 实时识别结果
    }
    this._manager.onStop = (res) => {
      const text = res.result || ''
      if (text) {
        // 尝试用 NLP 解析
        this.nlpParse(text)
      }
    }
    this._manager.onError = (err) => {
      console.error('voice error', err)
      wx.showToast({ title: '语音识别失败', icon: 'none' })
    }
  },

  // 加载旅程列表
  loadTrips() {
    wx.cloud.callFunction({
      name: 'travelRecord',
      data: { action: 'listTrips', page: 1, limit: 50 },
    }).then((res) => {
      if (res.result && res.result.success) {
        const trips = res.result.trips || []
        const tripOptions = [{ _id: '', title: '新建旅程（自动创建）' }, ...trips]
        this.setData({
          trips,
          tripOptions,
          tripPickerText: tripOptions[0].title,
        })

        // 如果已有 tripId，自动选中
        if (this.data.tripId) {
          const idx = tripOptions.findIndex((t) => t._id === this.data.tripId)
          if (idx > 0) {
            this.setData({
              tripIndex: idx,
              tripPickerText: tripOptions[idx].title,
              trip: trips.find((t) => t._id === this.data.tripId) || {},
            })
          }
        }
      }
    })
  },

  // 加载已有日记
  loadJournal(tripId, journalId) {
    wx.cloud.callFunction({
      name: 'travelRecord',
      data: { action: 'getTrip', tripId },
    }).then((res) => {
      if (res.result && res.result.success) {
        const entries = res.result.entries || []
        const journal = entries.find((e) => e._id === journalId)
        if (journal) {
          this.setData({
            date: journal.date,
            time: journal.time || '',
            day: journal.day,
            dayIndex: Math.max(0, (journal.day || 1) - 1),
            title: journal.title || '',
            content: journal.content || '',
            location: journal.location || null,
            photos: journal.photos || [],
            trip: res.result.trip,
          })
        }
      }
    })
  },

  // ========== 智能输入（自然语言 → 结构化） ==========
  onAiInputChange(e) {
    this.setData({ aiInputText: e.detail.value })
  },

  onAiInputConfirm() {
    const text = this.data.aiInputText.trim()
    if (!text) {
      wx.showToast({ title: '请输入内容', icon: 'none' })
      return
    }
    this.setData({ aiLoading: true })
    this.nlpParse(text)
  },

  // ========== 语音输入 ==========
  startVoiceInput() {
    wx.showModal({
      title: '语音输入',
      content: '点击「开始」后说话，说完后自动识别',
      confirmText: '开始录音',
      success: (res) => {
        if (res.confirm) {
          this._manager.start({ lang: 'zh_CN' })
          wx.showToast({ title: '正在听…', icon: 'none', duration: 60000 })
          // 3秒后自动停止
          setTimeout(() => {
            this._manager.stop()
            wx.hideToast()
          }, 3000)
        }
      },
    })
  },

  // NLP 解析
  nlpParse(text) {
    // 先显示原文
    this.setData({ content: text })

    // 尝试 AI 解析
    const callParams = { action: 'parseNaturalLanguage', text }
    if (this.data.trip && this.data.trip.startDate) {
      callParams.tripStartDate = this.data.trip.startDate
      callParams.tripEndDate = this.data.trip.endDate
    }
    wx.cloud.callFunction({
      name: 'travelRecord',
      data: callParams,
    }).then((res) => {
      this.setData({ aiLoading: false })
      if (res.result && res.result.success && res.result.parsed) {
        const p = res.result.parsed
        const updates = {}
        // 全量覆盖：AI 返回什么就填什么，没返回的字段清空
        updates.date = p.date || ''
        updates.time = p.time || ''
        updates.title = p.title || (p.location && p.location.name) || text.slice(0, 12) || ''
        updates.location = p.location && p.location.name
          ? { name: p.location.name }
          : { name: '' }
        updates.content = p.content || text
        updates.aiInputText = ''
        wx.showToast({ title: '✅ 已识别并填好', icon: 'none' })
        this.setData(updates)
        // 自动更新 day
        this.updateDayFromDate()
      }
    }).catch(() => {
      this.setData({ aiLoading: false })
      // NLP 失败，保留原文
    })
  },

  // ========== 地点选择 ==========
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

  // ========== 照片 ==========
  addPhoto() {
    wx.chooseMedia({
      count: 9 - this.data.photos.length,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = res.tempFiles || []
        const newPhotos = files.map((f) => f.tempFilePath)
        this.setData({
          photos: [...this.data.photos, ...newPhotos],
        })
      },
    })
  },

  removePhoto(e) {
    const idx = e.currentTarget.dataset.index
    const photos = [...this.data.photos]
    photos.splice(idx, 1)
    this.setData({ photos })
  },

  // ========== 表单输入 ==========
  onTripChange(e) {
    const idx = parseInt(e.detail.value)
    const opt = this.data.tripOptions[idx]
    this.setData({
      tripIndex: idx,
      tripPickerText: opt.title,
      tripId: opt._id,
      trip: this.data.trips.find((t) => t._id === opt._id) || {},
    })
  },

  onDateChange(e) {
    this.setData({ date: e.detail.value })
    // 自动计算 day
    this.updateDayFromDate()
  },

  onTimeChange(e) {
    this.setData({ time: e.detail.value })
  },

  onDayChange(e) {
    const idx = parseInt(e.detail.value)
    this.setData({ day: idx + 1, dayIndex: idx })
  },

  onTitleInput(e) {
    this.setData({ title: e.detail.value })
  },

  onContentInput(e) {
    this.setData({ content: e.detail.value })
  },

  // 根据旅程日期自动计算 day
  updateDayFromDate() {
    if (!this.data.tripId || !this.data.date || !this.data.trip.startDate) return
    const tripStart = new Date(this.data.trip.startDate)
    const current = new Date(this.data.date)
    if (tripStart && !isNaN(tripStart.getTime())) {
      const diff = Math.floor((current - tripStart) / (1000 * 60 * 60 * 24)) + 1
      if (diff > 0 && diff <= 10) {
        this.setData({ day: diff, dayIndex: diff - 1 })
      }
    }
  },

  // ========== 保存 ==========
  save() {
    if (!this.data.date) {
      wx.showToast({ title: '请选择日期', icon: 'none' })
      return
    }

    // 快速记录模式：如果没有选旅程，自动创建
    const saveData = {
      tripId: this.data.tripId,
      date: this.data.date,
      time: this.data.time,
      day: this.data.day,
      title: this.data.title,
      content: this.data.content,
      location: this.data.location,
      photos: this.data.photos,
    }

    if (this.data.journalId) {
      // 编辑模式
      saveData.journalId = this.data.journalId
      this.submitSave('updateJournal', saveData)
    } else if (this.data.mode === 'quick' && !this.data.tripId) {
      // 快速记录→自动创建旅程
      this.createTripAndSave(saveData)
    } else {
      this.submitSave('addJournal', saveData)
    }
  },

  // 自动创建旅程
  createTripAndSave(journalData) {
    const startDate = journalData.date
    // 猜测旅程名：用地点或日期
    const title = this.data.location
      ? `${this.data.location.name}之旅`
      : `${startDate} 的旅程`

    wx.cloud.callFunction({
      name: 'travelRecord',
      data: {
        action: 'createTrip',
        title,
        startDate,
        endDate: startDate,
        location: this.data.location ? this.data.location.name : '',
      },
    }).then((res) => {
      if (res.result && res.result.success) {
        journalData.tripId = res.result.tripId
        this.submitSave('addJournal', journalData)
      }
    }).catch((err) => {
      wx.showToast({ title: '创建旅程失败', icon: 'none' })
      console.error(err)
    })
  },

  submitSave(action, data) {
    wx.showLoading({ title: '保存中…' })

    // 上传照片到云存储
    this.uploadPhotos(data.photos).then((cloudUrls) => {
      data.photos = cloudUrls

      return wx.cloud.callFunction({
        name: 'travelRecord',
        data: { action, ...data },
      })
    }).then((res) => {
      wx.hideLoading()
      if (res.result && res.result.success) {
        wx.showToast({ title: '已保存' })
        // 返回上一页
        setTimeout(() => wx.navigateBack(), 500)
      } else {
        wx.showToast({ title: res.result.error || '保存失败', icon: 'none' })
      }
    }).catch((err) => {
      wx.hideLoading()
      console.error('save error', err)
      wx.showToast({ title: '保存失败', icon: 'none' })
    })
  },

  // 上传照片到云存储，返回 cloud:// 地址
  uploadPhotos(localPhotos) {
    if (!localPhotos || localPhotos.length === 0) return Promise.resolve([])

    const uploads = localPhotos.map((path, i) => {
      const m = path.match(/\.(\w+)$/)
      const ext = (m && m[1]) || 'jpg'
      const cloudPath = `travel/${Date.now()}_${i}.${ext}`
      return wx.cloud.uploadFile({
        cloudPath,
        filePath: path,
      }).then((res) => res.fileID)
    })

    return Promise.all(uploads)
  },
})