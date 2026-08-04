// 旅游记录 - 批量记录页（多日行程 NLP 语音/文字输入）
const plugin = requirePlugin('WechatSI')

const EXAMPLES = [
  '前天从上海飞去了北京，下午到了天安门，昨天上午去了天坛，中午吃火锅，下午逛了王府井，今天北京飞回了上海',
  '昨天上午爬黄山，下午逛宏村，今天上午看日出，下午回杭州',
  '昨天中午到成都吃火锅，下午逛宽窄巷子，晚上看变脸，今天上午看熊猫，下午去锦里',
]

Page({
  data: {
    inputText: '',
    parsing: false,
    parsed: false,
    days: [],
    totalEntries: 0,
    tripTitle: '',
    tripLocation: '',
    trips: [],

    // 编辑弹窗
    showEditModal: false,
    editDayIdx: -1,
    editEntryIdx: -1,
    editTime: '',
    editTitle: '',
    editLocationName: '',
    editContent: '',

    // 旅程选择器
    showTripPicker: false,

    // 语音
    _recording: false,
    _manager: null,
  },

  onLoad() {
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    this.setData({ today: todayStr })

    // 初始化语音识别
    this._manager = plugin.getRecordRecognitionManager()
    this._manager.onRecognize = () => {}
    this._manager.onStop = (res) => {
      const text = res.result || ''
      if (text) {
        this.setData({ inputText: text })
        wx.showToast({ title: '已识别，点击⚡解析', icon: 'none' })
      }
    }
    this._manager.onError = (err) => {
      console.error('voice error', err)
      wx.showToast({ title: '语音识别失败', icon: 'none' })
    }

    // 加载已有旅程列表（供"添加到已有旅程"用）
    this.loadTrips()
  },

  // ========== 输入 ==========
  onInputChange(e) {
    this.setData({ inputText: e.detail.value })
  },

  fillExample(e) {
    const idx = parseInt(e.currentTarget.dataset.example)
    this.setData({ inputText: EXAMPLES[idx] || '' })
  },

  // ========== 语音 ==========
  onVoiceTouchStart() {
    if (this.data._recording) return
    this.setData({ _recording: true })
    this._manager.start({ lang: 'zh_CN' })
    wx.showToast({ title: '🎤 录音中，松手结束', icon: 'none', duration: 60000 })
  },

  onVoiceTouchEnd() {
    if (!this.data._recording) return
    this.setData({ _recording: false })
    this._manager.stop()
    wx.hideToast()
  },

  // ========== 解析 ==========
  onParse() {
    const text = this.data.inputText.trim()
    if (!text) {
      wx.showToast({ title: '请输入行程描述', icon: 'none' })
      return
    }
    this.setData({ parsing: true, parsed: false })

    wx.cloud.callFunction({
      name: 'travelRecord',
      data: {
        action: 'parseMultiDay',
        text,
        today: this.data.today,
      },
    }).then((res) => {
      this.setData({ parsing: false })
      if (res.result && res.result.success) {
        this.setData({
          parsed: true,
          days: res.result.days || [],
          totalEntries: res.result.totalEntries || 0,
          tripTitle: res.result.tripTitle || '',
          tripLocation: '',
        })
        wx.showToast({ title: `✅ 解析出 ${res.result.totalEntries} 条日记`, icon: 'none' })
      } else {
        wx.showToast({ title: res.result.error || '解析失败', icon: 'none' })
      }
    }).catch((err) => {
      this.setData({ parsing: false })
      console.error('parseMultiDay failed', err)
      wx.showToast({ title: '网络错误', icon: 'none' })
    })
  },

  // ========== 编辑弹窗 ==========
  editEntry(e) {
    const dayIdx = parseInt(e.currentTarget.dataset.day)
    const eidx = parseInt(e.currentTarget.dataset.eidx)
    const entry = this.data.days[dayIdx].entries[eidx]
    this.setData({
      showEditModal: true,
      editDayIdx: dayIdx,
      editEntryIdx: eidx,
      editTime: entry.time || '',
      editTitle: entry.title || '',
      editLocationName: (entry.location && entry.location.name) || '',
      editContent: entry.content || '',
    })
  },

  closeEditModal() {
    this.setData({
      showEditModal: false,
      editDayIdx: -1,
      editEntryIdx: -1,
    })
  },

  onEditTimeChange(e) {
    this.setData({ editTime: e.detail.value })
  },
  onEditTitleInput(e) {
    this.setData({ editTitle: e.detail.value })
  },
  onEditLocationInput(e) {
    this.setData({ editLocationName: e.detail.value })
  },
  onEditContentInput(e) {
    this.setData({ editContent: e.detail.value })
  },

  chooseEditLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({ editLocationName: res.name })
      },
      fail: () => {},
    })
  },

  confirmEditEntry() {
    const { days, editDayIdx, editEntryIdx, editTime, editTitle, editLocationName, editContent } = this.data
    if (editDayIdx < 0 || editEntryIdx < 0) return

    const entry = days[editDayIdx].entries[editEntryIdx]
    entry.time = editTime
    entry.title = editTitle
    entry.location = editLocationName ? { name: editLocationName } : null
    entry.content = editContent

    this.setData({ days, showEditModal: false })
    wx.showToast({ title: '已更新', icon: 'none' })
  },

  // ========== 旅程信息 ==========
  onTripTitleChange(e) {
    this.setData({ tripTitle: e.detail.value })
  },
  onTripLocationChange(e) {
    this.setData({ tripLocation: e.detail.value })
  },

  // ========== 保存 ==========
  saveToNewTrip() {
    const { days, tripTitle, tripLocation } = this.data
    if (!days || days.length === 0) {
      wx.showToast({ title: '没有可保存的内容', icon: 'none' })
      return
    }

    const startDate = days[0].date
    const endDate = days[days.length - 1].date
    const title = tripTitle.trim() || `${startDate} 的旅程`

    this._doSave({ tripTitle: title, tripStartDate: startDate, tripEndDate: endDate, tripLocation: tripLocation.trim() })
  },

  saveToExistingTrip() {
    this.setData({ showTripPicker: true })
  },

  closeTripPicker() {
    this.setData({ showTripPicker: false })
  },

  selectTrip(e) {
    const tripId = e.currentTarget.dataset.id
    const tripTitle = e.currentTarget.dataset.title
    this.setData({ showTripPicker: false })

    const { days } = this.data
    const startDate = days[0].date
    const endDate = days[days.length - 1].date

    wx.showLoading({ title: '保存中…' })
    wx.cloud.callFunction({
      name: 'travelRecord',
      data: {
        action: 'saveMultiDay',
        days,
        tripStartDate: startDate,
        tripEndDate: endDate,
        targetTripId: tripId,
      },
    }).then((res) => {
      wx.hideLoading()
      if (res.result && res.result.success) {
        wx.showToast({ title: `✅ 已添加 ${res.result.journalCount} 条日记到「${tripTitle}」` })
        setTimeout(() => wx.navigateBack(), 800)
      } else {
        wx.showToast({ title: res.result.error || '保存失败', icon: 'none' })
      }
    }).catch((err) => {
      wx.hideLoading()
      console.error('saveToExistingTrip failed', err)
      wx.showToast({ title: '保存失败', icon: 'none' })
    })
  },

  _doSave({ tripTitle, tripStartDate, tripEndDate, tripLocation }) {
    const { days } = this.data

    wx.showLoading({ title: '创建旅程并保存…' })
    wx.cloud.callFunction({
      name: 'travelRecord',
      data: {
        action: 'saveMultiDay',
        days,
        tripTitle,
        tripStartDate,
        tripEndDate,
        tripLocation,
      },
    }).then((res) => {
      wx.hideLoading()
      if (res.result && res.result.success) {
        wx.showToast({ title: `✅ 已创建旅程并保存 ${res.result.journalCount} 条日记` })
        setTimeout(() => wx.navigateBack(), 800)
      } else {
        wx.showToast({ title: res.result.error || '保存失败', icon: 'none' })
      }
    }).catch((err) => {
      wx.hideLoading()
      console.error('saveMultiDay failed', err)
      wx.showToast({ title: '保存失败', icon: 'none' })
    })
  },

  // ========== 加载已有旅程列表 ==========
  loadTrips() {
    wx.cloud.callFunction({
      name: 'travelRecord',
      data: { action: 'listTrips', page: 1, limit: 50 },
    }).then((res) => {
      if (res.result && res.result.success) {
        this.setData({ trips: res.result.trips || [] })
      }
    }).catch(() => {})
  },
})