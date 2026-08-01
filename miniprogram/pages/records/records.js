const { checkDeleteResult } = require('../../utils/deleteResult')

// 金额保留两位小数（消除 JS 浮点累加误差，如 76.8 + 74.47 = 151.26999999999998）
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

Page({
  data: {
    records: [],
    loading: true,
    total: 0,
    totalExpense: 0,
    totalIncome: 0,
    showEdit: false,
    editId: '',
    editForm: { type: 'expense', amount: '', category: '', note: '' },
  },

  onShow() {
    this.loadRecords()
  },

  onLoad(options) {
    // 从查账面板跳来：定位某条记录并自动打开 改 / 删
    // options.targetId 必填，options.mode: 'edit'(默认) | 'delete'
    if (options && options.targetId) {
      this._targetId = options.targetId
      this._targetMode = options.mode === 'delete' ? 'delete' : 'edit'
    }
  },

  loadRecords() {
    this.setData({ loading: true })
    // 定位模式（从查账面板跳来）：放大时间范围确保能找到目标记录
    const isTarget = !!this._targetId
    const payload = isTarget
      ? { days: 3650, limit: 5000 }
      : { month: 'this', limit: 200 } // 北京时间本月 1 号 0 点起（含今天），与查账面板「本月」口径一致
    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: { action: 'list', payload },
    }).then((res) => {
      const result = res.result || {}
      if (result.success) {
        const list = (result.list || []).map((r) => {
          const d = r.createdAt ? new Date(r.createdAt) : null
          const dateStr = d
            ? (d.getMonth() + 1) + '月' + d.getDate() + '日'
            : ''
          const timeStr = d
            ? (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes())
            : ''
          return {
            _id: r._id,
            category: r.category || '其他',
            note: r.note || '',
            type: r.type || 'expense',
            amount: r.amount,
            amountText: round2(r.amount).toFixed(2),
            dateStr,
            timeStr,
          }
        })
        const totalExpense = round2(list.filter((r) => r.type !== 'income').reduce((s, r) => s + Math.abs(r.amount), 0))
        const totalIncome = round2(list.filter((r) => r.type === 'income').reduce((s, r) => s + Math.abs(r.amount), 0))
        this.setData({
          records: list,
          total: list.length,
          totalExpense,
          totalIncome,
          totalExpenseText: totalExpense.toFixed(2),
          totalIncomeText: totalIncome.toFixed(2),
          loading: false,
        })
        // 定位模式：找到目标记录后自动打开 改 / 删
        if (isTarget && this._targetId) {
          const found = list.find((r) => r._id === this._targetId)
          if (found) {
            if (this._targetMode === 'delete') {
              this.onDelete({ currentTarget: { dataset: { id: this._targetId } } })
            } else {
              this.onEdit({ currentTarget: { dataset: { id: this._targetId } } })
            }
          } else {
            wx.showToast({ title: '未找到该记录', icon: 'none' })
          }
          // 只定位一次，避免 onShow 重复触发
          this._targetId = null
          this._targetMode = null
        }
      } else {
        this.setData({ loading: false })
        wx.showToast({ title: '加载失败', icon: 'none' })
      }
    }).catch((err) => {
      console.error('list failed', err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id
    const rec = this.data.records.find((r) => r._id === id)
    if (!rec) return
    this.setData({
      showEdit: true,
      editId: id,
      editForm: {
        type: rec.type || 'expense',
        amount: String(Math.abs(rec.amount)),
        category: rec.category || '',
        note: rec.note || '',
      },
    })
  },

  closeEdit() {
    this.setData({ showEdit: false, editId: '' })
  },

  onMaskTap(e) {
    // 只有点到 mask 本身（非 edit-card 内部）才关闭
    if (e.target === e.currentTarget) {
      this.closeEdit()
    }
  },

  noop() {},

  onTypeTap(e) {
    this.setData({ 'editForm.type': e.currentTarget.dataset.type })
  },

  onAmountInput(e) {
    this.setData({ 'editForm.amount': e.detail.value })
  },

  onCategoryInput(e) {
    this.setData({ 'editForm.category': e.detail.value })
  },

  onNoteInput(e) {
    this.setData({ 'editForm.note': e.detail.value })
  },

  onSaveEdit() {
    const { editId, editForm } = this.data
    const amount = parseFloat(editForm.amount)
    if (isNaN(amount)) {
      wx.showToast({ title: '金额无效', icon: 'none' })
      return
    }
    const payload = {
      _id: editId,
      amount: editForm.type === 'income' ? Math.abs(amount) : -Math.abs(amount),
      type: editForm.type,
      category: editForm.category || '其他',
      note: editForm.note || '',
    }
    wx.showLoading({ title: '保存中' })
    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: { action: 'update', payload },
    }).then((res) => {
      wx.hideLoading()
      if (res.result && res.result.success) {
        wx.showToast({ title: '已保存', icon: 'success' })
        this.closeEdit()
        this.loadRecords()
        this.backToQueryAndRefresh()
      } else {
        wx.showToast({ title: '保存失败', icon: 'none' })
      }
    }).catch(() => {
      wx.hideLoading()
      wx.showToast({ title: '保存失败', icon: 'none' })
    })
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除记录',
      content: '确定删除这笔记录吗？',
      success: (res) => {
        if (!res.confirm) return
        wx.cloud.callFunction({
          name: 'miaojiRecord',
          data: { action: 'delete', payload: { _id: id } },
        }).then((del) => {
          const result = checkDeleteResult(del)
          if (result === 'ok') {
            wx.showToast({ title: '已删除', icon: 'success' })
            this.loadRecords()
            this.backToQueryAndRefresh()
          } else if (result === 'not-found') {
            wx.showToast({ title: '记录已不在（可能归属变更）', icon: 'none' })
            // 仍刷新一次，把「不在」的幽灵记录清掉
            this.loadRecords()
          } else {
            wx.showToast({ title: '删除失败', icon: 'none' })
          }
        }).catch(() => {
          wx.showToast({ title: '删除失败', icon: 'none' })
        })
      },
    })
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  },

  // 从查账面板跳来改/删后：刷新上一页（chatBot）的查账结果并返回
  backToQueryAndRefresh() {
    const pages = getCurrentPages()
    if (pages.length >= 2) {
      const prev = pages[pages.length - 2]
      if (prev && prev.route && prev.route.indexOf('chatBot') >= 0 && prev.refreshCurrentQuery) {
        prev.refreshCurrentQuery()
      }
    }
    setTimeout(() => wx.navigateBack({ delta: 1 }), 600)
  },
})
