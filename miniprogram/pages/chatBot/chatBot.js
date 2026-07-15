// pages/chatBot/chatBot.js
// 秒记记账对话：chatMode 用 model（直连大模型，忽略 Agent/bot）
//
// 架构（Curren 2026-07-14 确认）：模型先做意图判断，代码按 action 选分支执行。
//   用户输入 → classifyIntent（大模型判意图，正则抽线索喂它）→ {action: record|query|undo|chat|correct}
//     record/correct → 写库 + ✅ 卡片（金额正则保底，模型补抽模糊值）
//     query          → 查库 + 📊 模板（真实数据，代码生成，绝不幻觉）
//     undo           → 删最近一笔 + 🗑️ 卡片
//     chat           → 放行 agent-ui 模型自由对话（唯一模型发声的分支）
//   关键：模型在一轮里只输出意图 JSON，绝不输出给用户看的散文；
//        非 chat 分支抑制 agent-ui 模型回复（suppressModelOnce），只显示代码确定性卡片。
const { parseExpense, parseUndo, parseQuery } = require('../../utils/parseExpense')
const { classifyIntent } = require('../../utils/extractByModel')
const { collectStreamText } = require('../../utils/collectStreamText')

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
      allowVoice: true,
      showBotName: false,
    },
    modelConfig: {
      modelProvider: "cloudbase",
      quickResponseModel: "hy3",
      logo: "",
      welcomeMsg: "你好，我是秒记 💡 说出你的消费，我来帮你记。例如：午饭花了38块",
    },
    // 系统提示词：仅在 chat（闲聊）分支生效——此时 agent-ui 模型自由对话。
    // record/query/undo/correct 分支模型根本不通过 agent-ui 发声（被 suppress），
    // 这些分支的回复由前端代码按真实数据生成。所以这里只需把模型当"闲聊伙伴"。
    systemPrompt: "你是秒记，一款AI记账助手的闲聊模式。当用户只是闲聊或普通提问时，你正常、简洁、亲切地回答，像朋友一样。注意：用户说消费/收入/查询/撤回时，秒记会自动处理，你无需操心。始终用中文，口语化、有温度。",
    envShareConfig: null,
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

    // —— 同步段：正则快速预判（仅决定 suppress 与否，不作最终路由）——
    const regexExpense = parseExpense(text);
    const queryHint = parseQuery(text);
    const undoHint = !!parseUndo(text);
    const likelyNonChat = !!(regexExpense || queryHint || undoHint);
    if (likelyNonChat && comp && comp.suppressModelOnce) {
      comp.suppressModelOnce(); // 先闭嘴，等模型拍板
    }

    // —— 异步段：模型最终判意图（唯一调用大模型做决策的地方）——
    const recentRecord = await this.getLastRecord();
    let decision;
    try {
      decision = await classifyIntent(
        text,
        (prompt) => this.callModelForExtract(prompt),
        { regexExpense, queryHint, undoHint, recentRecord }
      );
    } catch (err) {
      decision = null;
    }

    // 模型降级失败：若之前 suppress 了，补一条闲聊模型回复；否则放行（agent-ui 已聊）
    if (!decision) {
      if (likelyNonChat) {
        const reply = await this.callChatModel(text);
        if (reply) this.appendQueryMsg(reply);
      }
      return;
    }

    // 模型判 chat：若我们误 suppress 了（带金额的闲聊等），补一条模型回复；否则 agent-ui 已正常聊
    if (decision.action === 'chat') {
      if (likelyNonChat) {
        const reply = await this.callChatModel(text);
        if (reply) this.appendQueryMsg(reply);
      }
      return;
    }

    // 非 chat 分支：已 suppress（likelyNonChat 时），按 action 执行确定性逻辑
    switch (decision.action) {
      case 'record':
        this.doAdd(decision, 'model');
        break;
      case 'correct':
        this.tryCorrect(decision, 'model');
        break;
      case 'query':
        this.tryQuery(decision.query);
        break;
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
        self.appendUndoMsg('ℹ️ 没有可撤回的记录');
        wx.showToast({ title: '没有记录', icon: 'none' });
        return;
      }
      const last = list[0];
      wx.cloud.callFunction({
        name: 'miaojiRecord',
        data: { action: 'delete', payload: { _id: last._id } },
      }).then((del) => {
        if (del.result && del.result.success) {
          const sign = last.amount < 0 ? '-' : '+';
          self.appendUndoMsg(`🗑️ 已撤回：**${last.category}** ${sign}¥${Math.abs(last.amount)}`);
          wx.showToast({ title: '已撤回', icon: 'success' });
        } else {
          wx.showToast({ title: '撤回失败', icon: 'none' });
        }
      }).catch((err) => {
        console.error('miaojiRecord delete failed', err);
        wx.showToast({ title: '撤回出错', icon: 'none' });
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
          ? '✅ 已记：**' + category + '** ' + sign + '¥' + Math.abs(amount) + notePart + '，数额不对随时跟我说改~'
          : '✅ 已记：**' + category + '** ' + sign + '¥' + Math.abs(amount) + notePart
        const comp = self.selectComponent('#agentui')
        if (comp && comp.appendAssistantMessage) comp.appendAssistantMessage(confirm)
        wx.showToast({ title: '记账成功', icon: 'success' })
      } else {
        wx.showToast({ title: '记账失败', icon: 'none' })
      }
    }).catch((err) => {
      console.error('miaojiRecord add failed', err)
      wx.showToast({ title: '记账出错', icon: 'none' })
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
          if (comp && comp.appendAssistantMessage) {
            comp.appendAssistantMessage('✅ 已更正：**' + category + '** ' + sign + '¥' + Math.abs(amount) + notePart)
          }
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
  // q: { type: 'month'|'day'|'category'|'recent', category?, month? }
  tryQuery(q) {
    const self = this
    let action = 'stats'
    let payload = {}
    if (q.type === 'day') {
      // 今日：用 summary 的 day 字段（stats 暂只支持月维度，day 走 summary 更稳）
      action = 'summary'
    } else if (q.type === 'recent') {
      action = 'list'
      payload = { limit: 8 }
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
        self.appendQueryMsg('😅 查询出错了，稍后再试试')
        return
      }
      const msg = self.buildQueryReply(q, res.result)
      self.appendQueryMsg(msg)
    }).catch((err) => {
      console.error('miaojiRecord query failed', err)
      self.appendQueryMsg('😅 查询出错了，稍后再试试')
    })
  },

  // 构造查询回答（模板，确定不幻觉）
  buildQueryReply(q, result) {
    const fmt = (n) => '¥' + Math.abs(n).toFixed(0)
    if (q.type === 'day') {
      const d = result.day || { income: 0, expense: 0 }
      if (d.expense === 0 && d.income === 0) return '📊 今天还没记账呢，说一笔我帮你记上~'
      let s = '📊 今天：支出 ' + fmt(d.expense)
      if (d.income > 0) s += '，收入 ' + fmt(d.income)
      return s
    }
    if (q.type === 'recent') {
      let list = result.list || []
      // only 过滤：income 只看收入，expense 只看支出（"收入明细"场景）
      if (q.only === 'income') list = list.filter((r) => r.type === 'income')
      else if (q.only === 'expense') list = list.filter((r) => r.type !== 'income')
      if (!list.length) return '📊 还没有任何记录哦，说一笔我帮你记~'
      const lines = list.slice(0, 8).map((r, i) => {
        const sign = r.type === 'income' ? '+' : '-'
        const cat = r.category || '其他'
        return (i + 1) + '. ' + cat + ' ' + sign + fmt(r.amount) + (r.note ? '（' + r.note + '）' : '')
      })
      const label = q.only === 'income' ? '收入' : q.only === 'expense' ? '支出' : ''
      return '📊 最近记的' + (label ? label : '') + list.length + ' 笔：\n' + lines.join('\n')
    }
    if (q.type === 'breakdown') {
      // 按分类统计支出：列出所有有支出的分类及金额（来自云函数 byCategory）
      const cats = result.byCategory || []
      if (!cats.length) return '📊 这个月还没记账呢，说一笔我帮你记上~'
      const lines = cats.map((c) => '· ' + c.category + ' ' + fmt(c.amount) + '（' + (c.count || 0) + ' 笔）')
      return '📊 这个月按分类统计（支出）：\n' + lines.join('\n')
    }
    if (q.type === 'income') {
      // 收入汇总：来自 stats 的 incomeTotal；并列出真实收入笔记录（过滤 records 中的 income 行）
      const income = result.incomeTotal || 0
      if (income === 0) return '📊 这个月还没有任何收入记录呢，说一笔我帮你记~'
      const incomeRecords = (result.records || []).filter((r) => r.type === 'income')
      let s = '📊 这个月收入一共 ' + fmt(income) + '（' + incomeRecords.length + ' 笔）'
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
      if (amount === 0) return '📊 这个月还没记过「' + q.category + '」呢~'
      return '📊 这个月「' + q.category + '」一共花了 ' + fmt(amount) + '（' + count + ' 笔）'
    }
    // month
    const expense = result.expenseTotal || 0
    const income = result.incomeTotal || 0
    const net = result.net || 0
    const count = result.count || 0
    if (count === 0) {
      return '📊 这个月还没记账呢，说一笔我帮你记上~'
    }
    let s = '📊 这个月你一共花了 ' + fmt(expense)
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
      const lines = []
      for (const cat of Object.keys(byCat)) {
        lines.push('【' + cat + '】')
        for (const r of byCat[cat]) {
          const d = r.createdAt ? new Date(r.createdAt) : null
          const dateStr = d ? (d.getMonth() + 1) + '月' + d.getDate() + '日' : ''
          const sign = r.type === 'income' ? '+' : '-'
          lines.push('- ' + dateStr + ' ' + (r.note || cat) + ' ' + sign + fmt(r.amount))
        }
      }
      s += '\n\n这个月的记账明细：\n' + lines.join('\n')
    }
    return s
  },

  // 往对话流追加查询回答（与记账确认同一通道，唯一来源）
  appendQueryMsg(msg) {
    const comp = this.selectComponent('#agentui')
    if (comp && comp.appendAssistantMessage) {
      comp.appendAssistantMessage(msg)
    }
  },

  // parseExpense 已抽到 utils/parseExpense.js（便于复用与单元测试）
  onLoad(options) {},
  onReady() {},
  onShow() {},
  onHide() {},
  onUnload() {},
  onPullDownRefresh() {},
  onReachBottom() {},
  onShareAppMessage() {},
});
