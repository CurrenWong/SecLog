// pages/chatBot/chatBot.js
// 秒记记账对话：chatMode 用 model（直连大模型，忽略 Agent/bot）
//
// 架构（Curren 2026-07-14 确认）：模型先做意图判断，代码按 action 选分支执行。
//   用户输入 → classifyIntent（大模型判意图，正则抽线索喂它）→ {action: record|query|undo|chat|correct}
//     record/correct → 写库 +  卡片（金额正则保底，模型补抽模糊值）
//     query          → 查库 +  模板（真实数据，代码生成，绝不幻觉）
//     undo           → 删最近一笔 +  卡片
//     chat           → 放行 agent-ui 模型自由对话（唯一模型发声的分支）
//   关键：模型在一轮里只输出意图 JSON，绝不输出给用户看的散文；
//        非 chat 分支抑制 agent-ui 模型回复（suppressModelOnce），只显示代码确定性卡片。
const { parseExpense, parseExpenses, parseUndo, parseQuery } = require('../../utils/parseExpense')
const { classifyIntent } = require('../../utils/extractByModel')
const { collectStreamText } = require('../../utils/collectStreamText')
const { buildFallbackHint, buildBlankFallbackHint } = require('../../utils/fallbackHint')
const { checkDeleteResult } = require('../../utils/deleteResult')

Page({
  data: {
    chatMode: "model", // model：直连大模型（cloudbase/hy3），不依赖 Agent
    showBotAvatar: true,
    agentConfig: {
      botId: "",
      allowWebSearch: false,
      allowUploadFile: false,
      allowPullRefresh: true,
      allowUploadImage: false,
      showToolCallDetail: false,
      allowMultiConversation: true,
      allowVoice: false, // 语音输入改用本页自带（微信同声传译插件），关掉 agent-ui 内置语音入口
      showBotName: false,
    },
    modelConfig: {
      modelProvider: "cloudbase",
      quickResponseModel: "hy3",
      logo: "/images/app-logo.png",
      welcomeMsg: "你好，我是秒记账，说出你的消费，我来帮你记。例如：午饭花了38块",
    },
    // 系统提示词：仅在 chat（闲聊）分支生效——此时 agent-ui 模型自由对话。
    // record/query/undo/correct 分支模型根本不通过 agent-ui 发声（被 suppress），
    // 这些分支的回复由前端代码按真实数据生成。所以这里只需把模型当"闲聊伙伴"。
    systemPrompt: "你是秒记，一款AI记账助手的闲聊模式。当用户只是闲聊或普通提问时，你正常、简洁、亲切地回答，像朋友一样。注意：用户说消费/收入/查询/撤回时，秒记会自动处理，你无需操心。始终用中文，口语化、有温度。",
    envShareConfig: null,
    // 多轮上下文（仅当前会话，小程序切走清空）
    // _history：最近 10 轮原始对话（user/assistant 文本），供 classifyIntent 全量指代消解
    // _ctx：最近一次 query 的 { query, summary }（远处摘要基础，history 超出 10 轮时压缩用）
    _history: [],
    _ctx: null,

    // 拍照记账：OCR 结果确认弹窗状态
    showOcrModal: false,
    ocrLoading: false,
    ocrResult: null, // { amount, merchant, category, date }
    ocrError: '',

    // 语音输入（微信同声传译插件）：本页自带，替代 agent-ui 内置语音
    voiceStatus: 0, // 0 空闲 1 录音中 2 识别中
    voiceText: '', // 识别结果预览
    voiceError: '',
    // agent-ui 底部工具栏（加号菜单）是否展开，用于抬高拍照按钮避免重叠
    toolsOpen: false,

    // —— 顶部双 Tab：记账（自然语言+拍照） / 查账（确定性面板，无模型）——
    activeTab: 'record', // 'record' | 'query'
    // 查账面板状态
    queryPresets: [
      { key: 'today', label: '今天' },
      { key: 'week', label: '本周' },
      { key: 'lastweek', label: '上周' },
      { key: 'month', label: '本月' },
      { key: 'lastmonth', label: '上月' },
      { key: 'year', label: '今年' },
      { key: 'lastyear', label: '去年' },
    ],
    // 自定义区间选择器状态
    showRangePicker: false,
    rangeFrom: '',
    rangeTo: '',
    // 当前选中的查账区间 key（用于按钮高亮，'custom' 表示自定义）
    // 默认 'month'：进查账面板自动高亮并查询本月
    activeQueryKey: 'month',
    queryLoading: false,
    queryResult: null, // { label, expenseTotal, incomeTotal, net, count, byCategory, records }
    queryError: '',
  },

  // Tab 切换
  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.activeTab) return
    this.setData({ activeTab: tab, queryError: '' })
    // 切到查账面板：若尚未查询过，默认查「本月」并高亮
    if (tab === 'query' && !this.data.queryResult && !this.data.queryLoading) {
      this.onQueryPreset({ currentTarget: { dataset: { key: 'month' } } })
    }
  },

  // 查账：点预设区间（确定性直调 miaojiRecord stats，不经过模型，好测）
  onQueryPreset(e) {
    const key = e.currentTarget.dataset.key
    const self = this
    self.setData({ queryLoading: true, queryError: '', queryResult: null, activeQueryKey: key })
    const pad = (n) => String(n).padStart(2, '0')
    const now = new Date()
    let payload = {}
    let label = ''
    if (key === 'today') {
      const ds = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      payload = { startDate: ds, endDate: ds }
      label = '今天'
    } else if (key === 'week' || key === 'lastweek') {
      const dow = (now.getDay() + 6) % 7
      let start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow)
      if (key === 'lastweek') start = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7)
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)
      payload = {
        startDate: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
        endDate: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`,
      }
      label = key === 'lastweek' ? '上周' : '本周'
    } else if (key === 'month') {
      payload = { month: 'this' }
      label = '本月'
    } else if (key === 'lastmonth') {
      // 上月：跨年处理（1月的上月=去年12月）
      const lm = now.getMonth() === 0 ? 11 : now.getMonth() - 1
      const ly = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
      const lastDay = new Date(ly, lm + 1, 0).getDate()
      payload = {
        startDate: `${ly}-${pad(lm + 1)}-01`,
        endDate: `${ly}-${pad(lm + 1)}-${lastDay}`,
      }
      label = `${ly}年${lm + 1}月`
    } else if (key === 'year') {
      payload = { startDate: `${now.getFullYear()}-01-01`, endDate: `${now.getFullYear()}-12-31` }
      label = now.getFullYear() + ' 年'
    } else if (key === 'lastyear') {
      const ly = now.getFullYear() - 1
      payload = { startDate: `${ly}-01-01`, endDate: `${ly}-12-31` }
      label = ly + ' 年'
    }
    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: { action: 'stats', payload },
    }).then((res) => {
      if (!res.result || !res.result.success) {
        self.setData({ queryLoading: false, queryError: '查询出错了，稍后再试试' })
        return
      }
      const r = res.result
      const fmtDate = (iso) => {
        if (!iso) return ''
        const d = new Date(iso)
        if (isNaN(d.getTime())) return iso
        const pad = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      }
      const records = (r.records || []).map((x) => ({ ...x, createdAt: fmtDate(x.createdAt), amountText: (x.amount || 0).toFixed(2) }))
      const byCategory = (r.byCategory || []).map((c) => ({ ...c, amountText: (c.amount || 0).toFixed(2) }))
      self.setData({
        queryLoading: false,
        queryResult: {
          label,
          expenseTotal: r.expenseTotal || 0,
          incomeTotal: r.incomeTotal || 0,
          expenseTotalText: (r.expenseTotal || 0).toFixed(2),
          incomeTotalText: (r.incomeTotal || 0).toFixed(2),
          net: r.net || 0,
          netText: (r.net || 0).toFixed(2),
          count: r.count || 0,
          byCategory,
          records,
        },
      })
    }).catch((err) => {
      console.error('miaojiRecord query failed', err)
      self.setData({ queryLoading: false, queryError: '查询出错了，稍后再试试' })
    })
  },

  // 自定义区间选择器：打开
  onOpenRangePicker() {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    // 默认填充本月 1 号 ~ 今天，降低使用门槛
    const from = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
    this.setData({ showRangePicker: true, rangeFrom: from, rangeTo: today })
  },
  onCloseRangePicker() {
    this.setData({ showRangePicker: false })
  },
  onRangeFromChange(e) {
    this.setData({ rangeFrom: e.detail.value })
  },
  onRangeToChange(e) {
    this.setData({ rangeTo: e.detail.value })
  },
  // 自定义区间查询
  onQueryRange() {
    const { rangeFrom, rangeTo } = this.data
    if (!rangeFrom || !rangeTo) {
      wx.showToast({ title: '请选择起止日期', icon: 'none' })
      return
    }
    if (rangeFrom > rangeTo) {
      wx.showToast({ title: '开始日期不能晚于结束', icon: 'none' })
      return
    }
    this.setData({ showRangePicker: false, queryLoading: true, queryError: '', queryResult: null, activeQueryKey: 'custom' })
    const self = this
    const label = `${rangeFrom} ~ ${rangeTo}`
    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: { action: 'stats', payload: { startDate: rangeFrom, endDate: rangeTo } },
    }).then((res) => {
      if (!res.result || !res.result.success) {
        self.setData({ queryLoading: false, queryError: '查询出错了，稍后再试试' })
        return
      }
      const r = res.result
      const fmtDate = (iso) => {
        if (!iso) return ''
        const d = new Date(iso)
        if (isNaN(d.getTime())) return iso
        const pad = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      }
      const records = (r.records || []).map((x) => ({ ...x, createdAt: fmtDate(x.createdAt), amountText: (x.amount || 0).toFixed(2) }))
      const byCategory = (r.byCategory || []).map((c) => ({ ...c, amountText: (c.amount || 0).toFixed(2) }))
      self.setData({
        queryLoading: false,
        queryResult: {
          label,
          expenseTotal: r.expenseTotal || 0,
          incomeTotal: r.incomeTotal || 0,
          expenseTotalText: (r.expenseTotal || 0).toFixed(2),
          incomeTotalText: (r.incomeTotal || 0).toFixed(2),
          net: r.net || 0,
          netText: (r.net || 0).toFixed(2),
          count: r.count || 0,
          byCategory,
          records,
        },
      })
    }).catch((err) => {
      console.error('miaojiRecord query failed', err)
      self.setData({ queryLoading: false, queryError: '查询出错了，稍后再试试' })
    })
  },

  // ——— 查账面板：单条记录的 改 / 删 ———
  // 复用 records 页已实现的改/删组件：跳转并带 targetId，
  // records 页会自动定位该记录并打开编辑弹窗（改）或删除确认（删）。
  onEditRecord(e) {
    const rec = e.currentTarget.dataset.rec
    if (!rec || !rec._id) return
    wx.navigateTo({ url: '/pages/records/records?targetId=' + rec._id + '&mode=edit' })
  },
  onDelRecord(e) {
    const rec = e.currentTarget.dataset.rec
    if (!rec || !rec._id) return
    wx.navigateTo({ url: '/pages/records/records?targetId=' + rec._id + '&mode=delete' })
  },

  // 用当前选中区间重查（改/删后刷新列表与汇总）
  refreshCurrentQuery() {
    const self = this
    const key = self.data.activeQueryKey
    if (key && key !== 'custom') {
      // 预设区间：直接复用 onQueryPreset 的查询逻辑
      self.onQueryPreset({ currentTarget: { dataset: { key } } })
    } else if (key === 'custom' && self.data.rangeFrom && self.data.rangeTo) {
      self.onQueryRange()
    } else {
      // 无有效区间，清空结果
      self.setData({ queryResult: null })
    }
  },

  // 用户输入发送时触发（agent-ui 抛出）
  // 架构：模型先判意图（classifyIntent），代码按 action 选分支。
  // 时序关键：agent-ui 的 sendMessage 在 triggerEvent 时同步跑 onUserSend，
  // 但 onUserSend 是 async（classifyIntent 需 await），sendMessage 不会等它。
  // 故 suppress 必须在【同步段】完成（首个 await 前），用正则快速预判是否非 chat。
  // 若正则预判为非 chat → 先 suppress（agent-ui 闭嘴），等模型拍板后走确定性分支；
  // 若模型最终判 chat（罕见误判，如带金额的闲聊）→ 用 callChatModel 补一条模型回复。
  async onUserSend(e) {
    const text = (e.detail && e.detail.content) || '';
    if (!text) return;
    const comp = this.selectComponent('#agentui');

    // 维护对话历史（滑动窗口 10 轮）：先记 user 句，供 classifyIntent 全量指代消解
    this.pushHistory({ role: 'user', text });

    // —— 同步段：正则快速预判（仅决定 suppress 与否，不作最终路由）——
    const regexExpense = parseExpense(text);
    const regexExpenses = parseExpenses(text); // 多笔预判线索（喂给模型，最终判定权在模型）
    const queryHint = parseQuery(text, this.data._ctx);
    const undoHint = !!parseUndo(text);
    const likelyNonChat = !!(regexExpense || queryHint || undoHint || regexExpenses.length >= 2);
    if (likelyNonChat && comp && comp.suppressModelOnce) {
      comp.suppressModelOnce(); // 先闭嘴，等模型拍板
    }

    // —— 异步段：模型最终判意图（唯一调用大模型做决策的地方）——
    // 正则多笔线索（regexExpenses）作为 hint 传入，但最终是否多笔、每笔金额/分类/归属由模型拍板，
    // 不轻信正则直落库（Curren 2026-07-16 确认：正则只抽线索，模型做最终判断）。
    const recentRecord = await this.getLastRecord();
    let decision;
    try {
      decision = await classifyIntent(
        text,
        (prompt) => this.callModelForExtract(prompt),
        {
          regexExpense,
          regexExpenses: regexExpenses.length >= 2 ? regexExpenses : null,
          queryHint,
          undoHint,
          recentRecord,
          ctx: this.data._ctx,
          history: this.getHistory(), // 最近 10 轮原始对话（含本轮 user，已 push）
        }
      );
    } catch (err) {
      decision = null;
    }

    // 模型降级失败：若之前 suppress 了，按正则线索反问补全；否则放行（agent-ui 已聊）
    // 优化：原"补一条闲聊模型回复"在 query/record 场景下没有工具上下文，会答非所问（用户感知为空白）。
    // 改为基于正则 hint 的明确反问（buildFallbackHint），让用户知道下一步怎么走。
    // 不影响成功路径：suppress 决策与各 action 分支未改动。
    if (!decision) {
      // 硬规则：解析层已命中记账意图（主路径或兜底），无论模型是否失败，直接 doAdd。
      // 杜绝"模型幻觉已记" + "代码没真记账"的场景。
      if (regexExpense) {
        this.doAdd({ amount: regexExpense.amount, category: regexExpense.category, note: regexExpense.note }, 'regex')
        return
      }
      // 硬规则：queryHint 有值 → 直接执行查询，不要反问"要查吗"。
      // 之前反问导致用户说"对"时第二次匹配不上，体验割裂。
      if (queryHint) {
        this.tryQuery(queryHint)
        return
      }
      // 硬规则：undoHint 有值 → 直接执行撤回，不要反问"要撤吗"。
      if (undoHint) {
        this.tryUndo(text)
        return
      }
      if (likelyNonChat) {
        const hint = buildFallbackHint({ regexExpense, queryHint, undoHint, text })
        this.appendQueryMsg(hint)
      } else {
        // 兜底：正则完全没命中 + 模型也失败/沉默——绝不能空白回复
        // 用 buildBlankFallbackHint 给"我能帮你什么"清单，避免用户以为程序没响应
        this.appendQueryMsg(buildBlankFallbackHint())
      }
      return;
    }

    // 模型判 chat：若我们误 suppress 了（带金额的闲聊等），补一条模型回复；否则 agent-ui 已正常聊
    if (decision.action === 'chat') {
      // 硬规则（Curren 2026-07-29 确认）：只要解析层命中记账意图（主路径或兜底），无论模型说什么 chat 都直接 doAdd。
      // 原因：模型有幻觉倾向会说"已帮你记啦～"但代码层没真写库；用户感知"说记账但没记"。强制 doAdd 杜绝此幻觉。
      if (regexExpense) {
        this.doAdd({ amount: regexExpense.amount, category: regexExpense.category, note: regexExpense.note }, 'regex')
        return
      }
      if (likelyNonChat) {
        const reply = await this.callChatModel(text);
        if (reply) {
          this.appendQueryMsg(reply)
        } else {
          // 兜底：模型也返回空（接口超时/限流），用 hint 反问，绝不空白
          const hint = buildFallbackHint({ regexExpense, queryHint, undoHint, text })
          this.appendQueryMsg(hint)
        }
      }
      return;
    }

    // 非 chat 分支：已 suppress（likelyNonChat 时），按 action 执行确定性逻辑
    switch (decision.action) {
      case 'multi_record':
        // 一句话多笔记账：模型已校验+归一每条记录，直接批量落库
        if (decision.records && decision.records.length >= 1) {
          this.doAddMulti(decision.records);
        }
        break;
      case 'record':
        // 被动填槽：用户说"记一笔"等无金额的记账意图 → amount 为 null，不记账，追问补全
        if (decision.amount === null || decision.amount === undefined) {
          this.appendQueryMsg('好的，这笔花了多少？什么类别？（比如"38 餐饮"）')
          return
        }
        this.doAdd(decision, 'model');
        break;
      case 'correct':
        this.tryCorrect(decision, 'model');
        break;
      case 'query': {
        // 正则预判比模型更确定：
        // 1. range 类型（"昨天"/"上周"→单日/周区间）——已有规则
        // 2. recent + category（"餐饮明细"→只过滤餐饮）——新增：模型不会透传 recent.category，必走正则
        const q = (queryHint && (queryHint.type === 'range' || (queryHint.type === 'recent' && queryHint.category)))
          ? queryHint
          : decision.query
        this.tryQuery(q);
        break;
      }
      case 'undo':
        this.tryUndo(text);
        break;
    }
  },

  // 纯闲聊模型回复（用于"正则预判 suppress 但模型判 chat"的补偿）。
  // 直接调 CloudBase AI 通道拿文本，append 到对话（不依赖 agent-ui 的 sendMessage，避免循环）。
  async callChatModel(text) {
    try {
      const { modelProvider, quickResponseModel } = this.data.modelConfig
      const cloudInstance = await require('../../utils/cloudInstance').getCloudInstance(this.data.envShareConfig)
      const ai = cloudInstance.extend.AI
      const aiModel = ai.createModel(modelProvider)
      const res = await aiModel.streamText({
        data: {
          model: quickResponseModel,
          messages: [
            ...(this.data.systemPrompt ? [{ role: 'system', content: this.data.systemPrompt }] : []),
            { role: 'user', content: text },
          ],
        },
      })
      const t = await collectStreamText(res)
      return t && t.trim() ? t.trim() : null
    } catch (e) {
      return null
    }
  },

  // 兼容：模型回复结束也可触发（用模型回复兜底解析，但优先用户原话）
  onMessageDone(e) {
    // 此处不重复记账，记账以用户原话为准（onUserSend）
  },

  // 撤回最近一笔记账。先查最近一笔（list limit=1），再 delete。
  tryUndo(text) {
    const self = this;
    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: { action: 'list', payload: { limit: 1 } },
    }).then((res) => {
      // 云函数 list 返回 { success, list: [...] }（字段名 list，非 data）
      const list = (res.result && res.result.success && res.result.list) || [];
      if (!list.length) {
        self.appendUndoMsg('没有可撤回的记录');
        wx.showToast({ title: '没有记录', icon: 'none' });
        return;
      }
      const last = list[0];
      wx.cloud.callFunction({
        name: 'miaojiRecord',
        data: { action: 'delete', payload: { _id: last._id } },
      }).then((del) => {
        const result = checkDeleteResult(del)
        if (result === 'ok') {
          const sign = last.amount < 0 ? '-' : '+'
          self.appendUndoMsg(` 已撤回：**${last.category}** ${sign}¥${Math.abs(last.amount)}`)
          wx.showToast({ title: '已撤回', icon: 'success' })
        } else if (result === 'not-found') {
          self.appendUndoMsg(' 撤回失败：记录已不在（或归属变更），可能已被同步刷新掉~')
          wx.showToast({ title: '记录已不在', icon: 'none' })
        } else {
          self.appendUndoMsg(' 撤回失败，稍后再试或刷新页面')
          wx.showToast({ title: '撤回失败', icon: 'none' })
        }
      }).catch((err) => {
        console.error('miaojiRecord delete failed', err)
        wx.showToast({ title: '撤回出错', icon: 'none' })
      });
    }).catch((err) => {
      console.error('miaojiRecord list failed', err);
      wx.showToast({ title: '撤回出错', icon: 'none' });
    });
  },

  // 在对话流追加撤回相关消息（与记账确认同一通道，唯一来源）
  appendUndoMsg(msg) {
    const comp = this.selectComponent('#agentui');
    if (comp && comp.appendAssistantMessage) {
      comp.appendAssistantMessage(msg);
    }
    this.pushHistory({ role: 'assistant', text: msg });
  },

  // 调大模型做结构化抽取（复用 CloudBase AI model 通道，与 agent-ui 一致）
  async callModelForExtract(prompt) {
    const { modelProvider, quickResponseModel } = this.data.modelConfig
    const cloudInstance = await require('../../utils/cloudInstance').getCloudInstance(this.data.envShareConfig)
    const ai = cloudInstance.extend.AI
    const aiModel = ai.createModel(modelProvider)
    const res = await aiModel.streamText({
      data: {
        model: quickResponseModel,
        messages: [{ role: 'user', content: prompt }],
      },
    })
    const text = await collectStreamText(res)
    return text
  },

  // 查最近一笔记账（limit=1），返回 { _id, amount, category, note } 或 null
  getLastRecord() {
    return new Promise((resolve) => {
      wx.cloud.callFunction({
        name: 'miaojiRecord',
        data: { action: 'list', payload: { limit: 1 } },
      }).then((res) => {
        const list = (res.result && res.result.success && res.result.list) || []
        if (!list.length) return resolve(null)
        const r = list[0]
        resolve({ _id: r._id, amount: r.amount, category: r.category, note: r.note })
      }).catch(() => resolve(null))
    })
  },

  // 记一笔新账。source: 'regex'=正则抽到确定值；'model'=模型兜底（模糊值带引导）
  doAdd(decision, source) {
    const self = this
    const { amount, category, note } = decision
    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: { action: 'add', payload: { amount, category, note } },
    }).then((res) => {
      if (res.result && res.result.success) {
        const sign = amount < 0 ? '-' : '+'
        const notePart = note ? '（' + note + '）' : ''
        const confirm = source === 'model'
          ? '[已记] **' + category + '** ' + sign + '¥' + Math.abs(amount) + notePart + '，数额不对随时跟我说改~'
          : ' 已记：**' + category + '** ' + sign + '¥' + Math.abs(amount) + notePart
        const comp = self.selectComponent('#agentui')
        if (comp && comp.appendAssistantMessage) comp.appendAssistantMessage(confirm)
        self.pushHistory({ role: 'assistant', text: confirm })
        wx.showToast({ title: '记账成功', icon: 'success' })
      } else {
        wx.showToast({ title: '记账失败', icon: 'none' })
      }
    }).catch((err) => {
      console.error('miaojiRecord add failed', err)
      wx.showToast({ title: '记账出错', icon: 'none' })
    })
  },

  // 一句话多笔记账：逐笔调云函数 add，全部成功才汇总回复
  doAddMulti(list) {
    const self = this
    let done = 0
    let failed = 0
    const lines = []
    list.forEach((item) => {
      wx.cloud.callFunction({
        name: 'miaojiRecord',
        data: { action: 'add', payload: { amount: item.amount, category: item.category, note: item.note } },
      }).then((res) => {
        if (res.result && res.result.success) {
          const sign = item.amount < 0 ? '-' : '+'
          const notePart = item.note ? '（' + item.note + '）' : ''
          lines.push('**' + item.category + '** ' + sign + '¥' + Math.abs(item.amount) + notePart)
        } else {
          failed++
        }
      }).catch(() => {
        failed++
      }).then(() => {
        done++
        if (done === list.length) {
          const comp = self.selectComponent('#agentui')
          if (failed === 0) {
            const msg = ' 已记 ' + list.length + ' 笔：\n' + lines.map((l) => '· ' + l).join('\n')
            if (comp && comp.appendAssistantMessage) comp.appendAssistantMessage(msg)
            self.pushHistory({ role: 'assistant', text: msg })
            wx.showToast({ title: '记了 ' + list.length + ' 笔', icon: 'success' })
          } else {
            const msg = ' 记了 ' + (list.length - failed) + ' 笔，' + failed + ' 笔失败'
            if (comp && comp.appendAssistantMessage) comp.appendAssistantMessage(msg)
            self.pushHistory({ role: 'assistant', text: msg })
            wx.showToast({ title: '部分失败', icon: 'none' })
          }
        }
      })
    })
  },

  // 更正最近一笔（用户说"错了/改成X"等）。decision: { amount, category, note, target }
  tryCorrect(decision, regexHint) {
    const self = this
    const { amount, category, note } = decision
    this.getLastRecord().then((last) => {
      if (!last) {
        // 没有可更正的记录 → 退化为新记一笔（更友好）
        self.doAdd({ amount, category, note }, regexHint ? 'regex' : 'model')
        return
      }
      wx.cloud.callFunction({
        name: 'miaojiRecord',
        data: {
          action: 'update',
          payload: { _id: last._id, amount, category, note },
        },
      }).then((res) => {
        if (res.result && res.result.success) {
          const sign = amount < 0 ? '-' : '+'
          const notePart = note ? '（' + note + '）' : ''
          const comp = self.selectComponent('#agentui')
          const correctMsg = ' 已更正：**' + category + '** ' + sign + '¥' + Math.abs(amount) + notePart
          if (comp && comp.appendAssistantMessage) {
            comp.appendAssistantMessage(correctMsg)
          }
          self.pushHistory({ role: 'assistant', text: correctMsg })
          wx.showToast({ title: '已更正', icon: 'success' })
        } else {
          wx.showToast({ title: '更正失败', icon: 'none' })
        }
      }).catch((err) => {
        console.error('miaojiRecord update failed', err)
        wx.showToast({ title: '更正出错', icon: 'none' })
      })
    })
  },

  // 统计查询：用户问"这个月花了多少/餐饮花了多少/最近记了啥"等，前端直接查库回答，不记账不调闲聊模型
  // q: { type: 'month'|'day'|'category'|'recent'|'range', category?, month?, range?, only? }
  tryQuery(q) {
    const self = this
    let action = 'stats'
    let payload = {}
    if (q.type === 'day') {
      // 今日：用 summary 的 day 字段（stats 暂只支持月维度，day 走 summary 更稳）
      action = 'summary'
    } else if (q.type === 'recent') {
      action = 'list'
      // 分类明细拉更多（limit 30），方便前端按 category 过滤后还能给到充足记录
      payload = { limit: q.category ? 30 : 8 }
    } else if (q.type === 'category') {
      action = 'stats'
      payload = { category: q.category }
    } else if (q.type === 'breakdown') {
      // 按分类统计：查全部分类聚合（云函数 stats 不传 category 即返回 byCategory）
      action = 'stats'
      payload = {}
    } else if (q.type === 'income') {
      // 收入汇总：走 stats（返回 records 全量 + incomeTotal，前端过滤 income 行做明细）
      action = 'stats'
      payload = {}
    } else if (q.type === 'range') {
      // 任意时间段：把 range 对象转成 startDate/endDate 给云函数 stats
      const range = q.range || {}
      let startDate
      let endDate
      let label
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      if (range.mode === 'year') {
        const y = range.year
        startDate = y + '-01-01'
        endDate = y + '-12-31'
        label = y + ' 年'
      } else if (range.mode === 'lastN') {
        const days = range.days || 30
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const start = new Date(end)
        start.setDate(start.getDate() - (days - 1))
        startDate = start.getFullYear() + '-' + pad(start.getMonth() + 1) + '-' + pad(start.getDate())
        endDate = end.getFullYear() + '-' + pad(end.getMonth() + 1) + '-' + pad(end.getDate())
        label = '最近 ' + days + ' 天'
      } else if (range.mode === 'between') {
        startDate = range.from
        endDate = range.to
        label = q.rangeLabel || (range.from + ' ~ ' + range.to)
      } else {
        // 兜底：本月
        startDate = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-01'
        const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
        endDate = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + last
        label = '本月'
      }
      action = 'stats'
      payload = { startDate, endDate, rangeLabel: label }
    } else {
      // month
      action = 'stats'
      payload = { month: q.month || 'this' }
    }

    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: { action, payload },
    }).then((res) => {
      if (!res.result || !res.result.success) {
        self.appendQueryMsg(' 查询出错了，稍后再试试')
        return
      }
      const msg = self.buildQueryReply(q, res.result)
      self.appendQueryMsg(msg)
      // 写多轮上下文：下一轮 classifyIntent 用它消解指代（"明细"/"那支出呢"/"6月呢"）
      self.setData({ _ctx: { query: q, summary: self.summarizeResult(q, res.result) } })
    }).catch((err) => {
      console.error('miaojiRecord query failed', err)
      self.appendQueryMsg(' 查询出错了，稍后再试试')
    })
  },

  // 从云函数 result 抽关键信息，作为下一轮指代消解的上下文摘要（不存全量，省 token）
  summarizeResult(q, result) {
    const s = { type: q.type }
    if (q.type === 'income') {
      s.incomeTotal = result.incomeTotal || 0
      s.incomeCount = (result.records || []).filter((r) => r.type === 'income').length
    } else if (q.type === 'month' || q.type === 'range') {
      s.expenseTotal = result.expenseTotal || 0
      s.incomeTotal = result.incomeTotal || 0
      s.count = result.count || 0
      if (q.type === 'range') s.rangeLabel = q.rangeLabel || '该时间段'
    } else if (q.type === 'category') {
      s.category = q.category
      s.amount = result.amount || 0
    } else if (q.type === 'breakdown') {
      s.cats = (result.byCategory || []).map((c) => c.category)
    } else if (q.type === 'recent') {
      s.count = (result.list || []).length
    } else if (q.type === 'day') {
      s.day = result.day || {}
    }
    return s
  },

  // 构造查询回答（模板，确定不幻觉）
  buildQueryReply(q, result) {
    const fmt = (n) => '¥' + Math.abs(n).toFixed(0)
    // range 模式：复用 month 总览展示，仅标题换成时间段 label
    if (q.type === 'range') {
      const label = q.rangeLabel || '该时间段'
      const expense = result.expenseTotal || 0
      const income = result.incomeTotal || 0
      const net = result.net || 0
      const count = result.count || 0
      if (count === 0) {
        return ' ' + label + '还没记账呢，说一笔我帮你记上~'
      }
      let s = ' ' + label + '你一共花了 ' + fmt(expense)
      if (income > 0) s += '，收入 ' + fmt(income) + '，净 ' + (net < 0 ? '-' : '+') + fmt(net)
      const cats = result.byCategory || []
      if (cats.length) {
        const top = cats.slice(0, 3)
          .map((c) => c.category + ' ' + fmt(c.amount))
          .join('、')
        s += '\n最多的是：' + top
      }
      const records = result.records || []
      if (records.length) {
        const byCat = {}
        for (const r of records) {
          const cat = r.category || '其他'
          if (!byCat[cat]) byCat[cat] = []
          byCat[cat].push(r)
        }
        s += '\n\n该时间段的记账明细：'
        for (const cat of Object.keys(byCat)) {
          s += '\n\n' + cat + '：'
          for (const r of byCat[cat]) {
            const d = r.createdAt ? new Date(r.createdAt) : null
            const dateStr = d ? (d.getMonth() + 1) + '月' + d.getDate() + '日' : ''
            const sign = r.type === 'income' ? '+' : '-'
            s += '\n- ' + dateStr + ' ' + (r.note || cat) + ' ' + sign + fmt(r.amount)
          }
        }
      }
      return s
    }
    if (q.type === 'day') {
      const d = result.day || { income: 0, expense: 0 }
      if (d.expense === 0 && d.income === 0) return ' 今天还没记账呢，说一笔我帮你记上~'
      let s = ' 今天：支出 ' + fmt(d.expense)
      if (d.income > 0) s += '，收入 ' + fmt(d.income)
      return s
    }
    if (q.type === 'recent') {
      let list = result.list || []
      // only 过滤：income 只看收入，expense 只看支出（"收入明细"场景）
      if (q.only === 'income') list = list.filter((r) => r.type === 'income')
      else if (q.only === 'expense') list = list.filter((r) => r.type !== 'income')
      // 分类过滤：分类明细（"餐饮明细"→ 只看餐饮的记录）
      if (q.category) list = list.filter((r) => r.category === q.category)
      if (!list.length) return ' 还没有任何记录哦，说一笔我帮你记~'
      const lines = list.slice(0, 8).map((r, i) => {
        const sign = r.type === 'income' ? '+' : '-'
        const cat = r.category || '其他'
        return (i + 1) + '. ' + cat + ' ' + sign + fmt(r.amount) + (r.note ? '（' + r.note + '）' : '')
      })
      const label = q.only === 'income' ? '收入' : q.only === 'expense' ? '支出' : ''
      // 标题与列表之间加空行（markdown 渲染要求），避免被压成一行
      return '【最近记的' + (label ? label : '') + list.length + ' 笔】\n\n' + lines.join('\n')
    }
    if (q.type === 'breakdown') {
      // 按分类统计支出：列出所有有支出的分类及金额（来自云函数 byCategory）
      const cats = result.byCategory || []
      if (!cats.length) return ' 这个月还没记账呢，说一笔我帮你记上~'
      const lines = cats.map((c) => '· ' + c.category + ' ' + fmt(c.amount) + '（' + (c.count || 0) + ' 笔）')
      return ' 这个月按分类统计（支出）：\n' + lines.join('\n')
    }
    if (q.type === 'income') {
      // 收入汇总：来自 stats 的 incomeTotal；并列出真实收入笔记录（过滤 records 中的 income 行）
      const income = result.incomeTotal || 0
      if (income === 0) return ' 这个月还没有任何收入记录呢，说一笔我帮你记~'
      const incomeRecords = (result.records || []).filter((r) => r.type === 'income')
      let s = ' 这个月收入一共 ' + fmt(income) + '（' + incomeRecords.length + ' 笔）'
      if (incomeRecords.length) {
        const lines = incomeRecords.map((r) => {
          const d = r.createdAt ? new Date(r.createdAt) : null
          const dateStr = d ? (d.getMonth() + 1) + '月' + d.getDate() + '日' : ''
          return '- ' + dateStr + ' ' + (r.note || r.category || '收入') + ' +' + fmt(r.amount)
        })
        s += '：\n' + lines.join('\n')
      }
      return s
    }
    if (q.type === 'category') {
      const amount = result.amount || 0
      const count = result.count || 0
      if (amount === 0) return ' 这个月还没记过「' + q.category + '」呢~'
      return ' 这个月「' + q.category + '」一共花了 ' + fmt(amount) + '（' + count + ' 笔）'
    }
    // month
    const expense = result.expenseTotal || 0
    const income = result.incomeTotal || 0
    const net = result.net || 0
    const count = result.count || 0
    if (count === 0) {
      return ' 这个月还没记账呢，说一笔我帮你记上~'
    }
    let s = ' 这个月你一共花了 ' + fmt(expense)
    if (income > 0) s += '，收入 ' + fmt(income) + '，净 ' + (net < 0 ? '-' : '+') + fmt(net)
    const cats = result.byCategory || []
    if (cats.length) {
      const top = cats.slice(0, 3)
        .map((c) => c.category + ' ' + fmt(c.amount))
        .join('、')
      s += '\n最多的是：' + top
    }
    // 真实逐笔明细（从云函数返回的 records 拼，绝不编造）
    const records = result.records || []
    if (records.length) {
      // 按分类分组
      const byCat = {}
      for (const r of records) {
        const cat = r.category || '其他'
        if (!byCat[cat]) byCat[cat] = []
        byCat[cat].push(r)
      }
      s += '\n\n这个月的记账明细：'
      for (const cat of Object.keys(byCat)) {
        // 每个分类独立成块：标题行 + 空行 + 列表（markdown 列表需前有空行才渲染）
        s += '\n\n' + cat + '：'
        for (const r of byCat[cat]) {
          const d = r.createdAt ? new Date(r.createdAt) : null
          const dateStr = d ? (d.getMonth() + 1) + '月' + d.getDate() + '日' : ''
          const sign = r.type === 'income' ? '+' : '-'
          s += '\n- ' + dateStr + ' ' + (r.note || cat) + ' ' + sign + fmt(r.amount)
        }
      }
    }
    return s
  },

  // 对话历史（滑动窗口 10 轮，仅当前会话）。用于 classifyIntent 全量指代消解。
  pushHistory(entry) {
    const h = this.data._history || []
    h.push(entry)
    // 超 10 轮：前 (len-10) 条压成 distantSummary（简单拼接关键词，远处摘要）
    if (h.length > 10) {
      const overflow = h.slice(0, h.length - 10)
      const summary = overflow
        .map((e) => (e.role === 'user' ? 'U:' + e.text : 'A:' + e.text))
        .join(' | ')
      this.data._ctx = Object.assign({}, this.data._ctx, { distantSummary: summary })
      h.splice(0, h.length - 10)
    }
    this.setData({ _history: h })
  },

  // 取最近 10 轮历史（classifyIntent 用）。含本轮 user（onUserSend 已 push）
  getHistory() {
    return (this.data._history || []).slice(-10)
  },

  // 往对话流追加查询回答（与记账确认同一通道，唯一来源）
  appendQueryMsg(msg) {
    const comp = this.selectComponent('#agentui')
    if (comp && comp.appendAssistantMessage) {
      comp.appendAssistantMessage(msg)
    }
    this.pushHistory({ role: 'assistant', text: msg })
  },

  // buildFallbackHint 已抽至 utils/fallbackHint.js（项目内单测覆盖）

  // parseExpense 已抽到 utils/parseExpense.js（便于复用与单元测试）
  onLoad(options) {
    // 初始化语音输入（微信同声传译插件）
    this.initVoice()
  },

  // agent-ui 加号菜单展开/收起：抬高拍照按钮避免重叠
  onToolsToggle(e) {
    this.setData({ toolsOpen: !!(e && e.detail && e.detail.show) })
  },

  // ——— 语音输入：微信同声传译插件（recordRecoManager 流式识别）———
  initVoice() {
    try {
      const plugin = requirePlugin('WechatSI')
      const manager = plugin.getRecordRecognitionManager()
      manager.onStart = (res) => {
        console.log('语音识别开始', res)
      }
      manager.onStop = (res) => {
        this.onVoiceResult(res)
      }
      manager.onError = (res) => {
        console.error('语音识别错误', res)
        this.setData({ voiceStatus: 0, voiceError: (res && res.msg) || '识别出错' })
      }
      this._voiceManager = manager
    } catch (e) {
      console.error('WechatSI plugin load failed', e)
      this.setData({ voiceError: '语音插件未启用（需在小程序后台添加微信同声传译插件）' })
    }
  },

  // 按住说话
  onVoiceStart() {
    if (this.data.voiceStatus === 2) return
    if (!this._voiceManager) {
      wx.showModal({ title: '语音不可用', content: '请在小程序后台「设置→第三方设置→插件管理」添加「微信同声传译」插件后重试', showCancel: false })
      return
    }
    this._voiceCancel = false
    this.setData({ voiceStatus: 1, voiceError: '', voiceText: '' })
    this._voiceManager.start({ duration: 60000, lang: 'zh_CN' })
  },

  // 松手：结束识别
  onVoiceEnd() {
    if (this.data.voiceStatus !== 1) return
    if (this._voiceManager) this._voiceManager.stop()
  },

  // 上滑取消
  onVoiceCancel() {
    this._voiceCancel = true
    if (this.data.voiceStatus === 1 && this._voiceManager) {
      this._voiceManager.stop()
    }
  },

  onVoiceResult(res) {
    const self = this
    const wasCancel = this._voiceCancel
    this._voiceCancel = false
    if (wasCancel) {
      this.setData({ voiceStatus: 0, voiceText: '' })
      return
    }
    const text = ((res && res.result) || '').trim()
    if (!text) {
      this.setData({ voiceStatus: 0, voiceError: '没听清，再说一次' })
      return
    }
    this.setData({ voiceStatus: 0, voiceText: text })
    // 直接发给 agent-ui（走正常记账/查账意图识别）
    const comp = self.selectComponent('#agentui')
    if (comp && comp.sendMessage) {
      comp.sendMessage(text)
    } else {
      wx.showToast({ title: '发送失败', icon: 'none' })
    }
  },
  onReady() {},
  onShow() {
    // 进查账面板（query tab）且尚未查询时，默认查「本月」并高亮
    if (this.data.activeTab === 'query' && !this.data.queryResult && !this.data.queryLoading) {
      this.onQueryPreset({ currentTarget: { dataset: { key: 'month' } } })
    }
  },
  onHide() {},
  onUnload() {},
  onPullDownRefresh() {},
  onReachBottom() {},
  onShareAppMessage() {},

  // 空函数：用于 catchtap 阻止事件冒泡（弹窗内容点击不关闭弹窗）
  noop() {},

  // —— 拍照记账：选图 → 上传 → 云函数 OCR → 确认弹窗 ——
  async onPhotoAccount() {
    const self = this
    if (this.data.ocrLoading) return
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      // 压缩图（系统压缩 + 二次压缩）：OCR 不需要高分辨率，减小图片体积加速上传和识别
      sizeType: ['compressed'],
      success: async (res) => {
        const tempFile = res.tempFiles && res.tempFiles[0]
        if (!tempFile) return
        self.setData({ ocrLoading: true, ocrError: '' })
        try {
          // 1. 二次压缩：限制最长边 480px + quality 50%（OCR 小票/发票够用，极致压缩加速上传 + 识别）
          let toUpload = tempFile.tempFilePath
          try {
            const compressed = await wx.compressImage({
              src: tempFile.tempFilePath,
              compressedHeight: 480,
              quality: 50,
            })
            if (compressed && compressed.tempFilePath) toUpload = compressed.tempFilePath
          } catch (e) {
            // 压缩失败也照传原图（不阻断流程）
            console.warn('compressImage failed, use original', e)
          }

          // 2. 上传到云存储（显式 60s 超时）
          const ext = (toUpload.split('.').pop() || 'png').split('?')[0]
          const cloudPath = `ocr_tmp/${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`
          const up = await wx.cloud.uploadFile({ cloudPath, filePath: toUpload, config: { timeout: 60000 } })
          if (!up || !up.fileID) throw new Error('上传失败')

          // 2. 调云函数 OCR（云函数内用 cloud.ai() 调 qwen3.5-flash 多模态识别）
          // 显式 60s 超时：wx.cloud.callFunction 默认 10s，OCR 冷启动+多模态经常 4-15s
          const r = await new Promise((resolve, reject) => {
            wx.cloud.callFunction({
              name: 'miaojiRecord',
              data: { action: 'ocr', payload: { imageUrl: up.fileID } },
              config: { timeout: 60000 },
            }).then((res) => resolve(res.result)).catch(reject)
          })

          if (!r || !r.success) {
            const msg = (r && (r.message || r.code)) || '识别失败'
            throw new Error(msg)
          }

          // 3. 展示确认弹窗（可改金额/类别）
          self.setData({
            showOcrModal: true,
            ocrResult: {
              amount: r.amount != null ? String(r.amount) : '',
              merchant: r.merchant || '',
              category: r.category || '其他',
              type: 'expense', // 默认支出（小票绝大多数是消费）
              date: r.date || '',
            },
          })
        } catch (e) {
          const msg = (e && e.message) || '拍照记账出错'
          self.setData({ ocrError: msg })
          // 识别失败时给更明确的提示：PNG 截图比相册 JPEG 识别更稳
          const hint = /timeout|超时/.test(msg) ? '识别超时，建议用截图（PNG）重试' : msg
          wx.showToast({ title: hint, icon: 'none', duration: 2500 })
        } finally {
          self.setData({ ocrLoading: false })
        }
      },
      fail: (e) => {
        // 用户取消选择，不提示
        if (e && e.errMsg && e.errMsg.indexOf('cancel') >= 0) return
        wx.showToast({ title: '选择图片失败', icon: 'none' })
      },
    })
  },

  // 确认弹窗里改金额/类别
  onOcrAmountInput(e) {
    this.setData({ 'ocrResult.amount': e.detail.value })
  },
  onOcrMerchantInput(e) {
    this.setData({ 'ocrResult.merchant': e.detail.value })
  },
  onOcrCategoryChange(e) {
    const categories = ['餐饮','交通','购物','居家','医疗','娱乐','教育','其他']
    this.setData({ 'ocrResult.category': categories[e.detail.value] || '其他' })
  },
  // 收入/支出切换（默认支出，用户在确认弹窗可改）
  onOcrTypeChange(e) {
    const t = e.currentTarget.dataset.type
    if (t !== 'income' && t !== 'expense') return
    this.setData({ 'ocrResult.type': t })
  },

  // 取消确认
  onOcrCancel() {
    this.setData({ showOcrModal: false, ocrResult: null, ocrError: '' })
  },

  // 确认记账
  onOcrConfirm() {
    const r = this.data.ocrResult
    if (!r) return
    const absAmount = parseFloat(r.amount)
    if (isNaN(absAmount) || absAmount <= 0) {
      wx.showToast({ title: '金额无效', icon: 'none' })
      return
    }
    // 支出存负数，收入存正数（默认支出）
    const amount = r.type === 'income' ? absAmount : -absAmount
    const note = r.merchant ? r.merchant : ''
    this.setData({ showOcrModal: false })
    const comp = this.selectComponent('#agentui')
    if (comp && comp.appendAssistantMessage) {
      comp.appendAssistantMessage('正在识别小票并记账…')
    }
    // 复用 doAdd（走 miaojiRecord add）
    this.doAdd({ amount, category: r.category, note }, 'model')
    this.setData({ ocrResult: null })
  },
});
