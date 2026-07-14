// pages/chatBot/chatBot.js
// 秒记记账对话：chatMode 用 model（直连大模型，忽略 Agent/bot）
// 记账逻辑完全在前端：监听 agent-ui 的 userSend 事件拿用户输入，
// 解析消费信息，调用 miaojiRecord 云函数写入数据库，并在对话里追加记账确认。
// 混合抽取：正则（parseExpense）命中即记；完全抽不到时降级调大模型（extractByModel）。
const { parseExpense, parseUndo, parseQuery } = require('../../utils/parseExpense')
const { extractByModel } = require('../../utils/extractByModel')
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
    // 系统提示词：让直连大模型具备"秒记记账助手"人设
    // 关键：记账确认由前端代码统一插入（✅ 已记...），模型【不要】重复确认或复述金额，
    // 只在需要时自然接一句话（如补充提醒），避免对话里出现两条确认。
    systemPrompt: "你是秒记，一款AI记账助手。规则：1) 当用户说出一笔消费或收入，秒记会自动记账并在对话里插入一条✅已记的确认，你【不要】再重复确认、不要复述金额，只需自然接一句轻松的话（如'好嘞，记上啦~'或'收到，已经帮你记好~'），不超过两句；2) 若用户说'错了/改成X/应该是X'等修正意图，秒记会自动帮你改好，你只需自然轻松地接一句（如'好嘞，已经帮你改成60啦~'或'没问题，改好咯~'），【不要】只回'改好'两个字的生硬短句，也不要复述金额；3) 若用户提问【统计/花了多少/这个月开销/明细/分类汇总】等查询类问题，秒记会自动用【真实数据库】查出结果并插入对话（含准确金额和真实逐笔明细），你【绝对不要】自己算数字、【绝对不要】编造任何金额或明细清单，只回一句极轻量的接话（如'我帮你查一下~'）或不回；4) 若用户只是普通闲聊，正常简洁回答；5) 始终用中文，口语化、亲切、有温度。",
    envShareConfig: null,
  },

  // 用户输入发送时触发（agent-ui 抛出）
  onUserSend(e) {
    const text = (e.detail && e.detail.content) || '';
    // 先判撤回意图（确定性正则，即时，不调模型）
    if (parseUndo(text)) {
      this.tryUndo(text);
      return;
    }
    // 再判统计查询意图（看汇总/分类/明细，不记账不闲聊）
    const q = parseQuery(text)
    if (q) {
      this.tryQuery(q);
      return;
    }
    this.tryRecord(text);
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
    // 诊断日志：扫码联调时可在开发者工具 console 看到模型原始返回（后续可删）
    // 同时打出 res 的字段形态，定位真机 streamText 实际返回结构
    const resKeys = res && typeof res === 'object' ? Object.keys(res) : '(' + typeof res + ')'
    const hasStreams = res && typeof res === 'object'
      ? { eventStream: !!(res.eventStream && typeof res.eventStream[Symbol.asyncIterator] === 'function'), textStream: !!(res.textStream && typeof res.textStream[Symbol.asyncIterator] === 'function') }
      : null
    console.log('[callModelForExtract] resType:', typeof res, '| resKeys:', JSON.stringify(resKeys), '| hasStreams:', JSON.stringify(hasStreams), '| extractedText:', JSON.stringify(text).slice(0, 300))
    return text
  },

  // 解析消费文本并记账。混合策略：正则优先（确定），模型兜底（模糊）。
  // 正则判断不出 → 必须让大模型判断意图：抽到则记（模糊值带核实语气），
  // 模型确认非记账(intent:false) → 交给对话变闲聊，两层都失败则保守不记。
  // source 记录来源：regex=确定值直接确认；model=模糊值带核实语气。
  // 混合策略（新）：正则做第一遍快速抽取 → 结果作为线索喂给模型，模型最终拍板。
  // 模型返回统一结构 { action: 'add'|'correct'|'none', ... }，前端按 action 分支处理。
  async tryRecord(text) {
    if (!text) return;
    // 第一遍：正则快速抽取（作为线索喂给模型，不再独裁）
    const regexHint = parseExpense(text)
    // 第二遍：调大模型，结合正则线索 + 最近一笔上下文，最终拍板
    let decision
    try {
      const recent = await this.getLastRecord()
      decision = await extractByModel(
        text,
        (prompt) => this.callModelForExtract(prompt),
        { regexHint, recentRecord: recent }
      )
    } catch (e) {
      decision = null
    }
    if (!decision || decision.action === 'none') return; // 非记账意图 → 交给模型正常对话

    if (decision.action === 'correct') {
      this.tryCorrect(decision, regexHint)
      return
    }
    // action === 'add'
    this.doAdd(decision, regexHint ? 'regex' : 'model')
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
      const list = result.list || []
      if (!list.length) return '📊 还没有任何记录哦，说一笔我帮你记~'
      const lines = list.slice(0, 8).map((r, i) => {
        const sign = r.type === 'income' ? '+' : '-'
        const cat = r.category || '其他'
        return (i + 1) + '. ' + cat + ' ' + sign + fmt(r.amount) + (r.note ? '（' + r.note + '）' : '')
      })
      return '📊 最近记的 ' + list.length + ' 笔：\n' + lines.join('\n')
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
