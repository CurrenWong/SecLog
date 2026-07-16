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

  loadRecords() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: { action: 'list', payload: { days: 30, limit: 200 } },
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
            dateStr,
            timeStr,
          }
        })
        const totalExpense = list.filter((r) => r.type !== 'income').reduce((s, r) => s + Math.abs(r.amount), 0)
        const totalIncome = list.filter((r) => r.type === 'income').reduce((s, r) => s + Math.abs(r.amount), 0)
        this.setData({
          records: list,
          total: list.length,
          totalExpense,
          totalIncome,
          loading: false,
        })
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
        }).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' })
          this.loadRecords()
        }).catch(() => {
          wx.showToast({ title: '删除失败', icon: 'none' })
        })
      },
    })
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  },
})
