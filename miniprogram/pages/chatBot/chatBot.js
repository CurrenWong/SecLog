// pages/chatBot/chatBot.js
// 秒记记账对话：chatMode 用 model（直连大模型，忽略 Agent/bot）
// 记账逻辑完全在前端：监听 agent-ui 的 userSend 事件拿用户输入，
// 解析消费信息，调用 miaojiRecord 云函数写入数据库，并在对话里追加记账确认。
// 混合抽取：正则（parseExpense）命中即记；完全抽不到时降级调大模型（extractByModel）。
const { parseExpense, parseUndo } = require('../../utils/parseExpense')
const { extractByModel } = require('../../utils/extractByModel')

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
    systemPrompt: "你是秒记，一款AI记账助手。规则：1) 当用户说出一笔消费或收入，秒记会自动记账并在对话里插入一条✅已记的确认，你【不要】再重复确认、不要复述金额，只需自然接一句话（如'好的~'或相关小提醒），不超过两句；2) 若用户只是闲聊或提问，正常简洁回答；3) 始终用中文，口语化。",
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
          self.appendUndoMsg(`🗑️ 已撤回：<b>${last.category}</b> ${sign}¥${Math.abs(last.amount)}`);
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
    let text = ''
    const res = await aiModel.streamText({
      data: {
        model: quickResponseModel,
        messages: [{ role: 'user', content: prompt }],
      },
    })
    // streamText 返回异步迭代器或带 text 字段的结果，兼容两种
    if (res && typeof res[Symbol.asyncIterator] === 'function') {
      for await (const chunk of res) {
        text += (chunk.delta || chunk.text || (typeof chunk === 'string' ? chunk : ''))
      }
    } else if (res && res.text) {
      text = res.text
    }
    return text
  },

  // 解析消费文本并记账。混合策略：正则优先（确定），模型兜底（模糊）。
  // source 记录来源：regex=确定值直接确认；model=模糊值带核实语气。
  async tryRecord(text) {
    if (!text) return;
    let parsed = parseExpense(text) // 正则（快/免费/确定）
    let source = parsed ? 'regex' : null
    if (!parsed) {
      // 正则完全抽不到 → 降级调大模型
      try {
        parsed = await extractByModel(text, (prompt) => this.callModelForExtract(prompt))
        if (parsed) source = 'model'
      } catch (e) {
        parsed = null
      }
    }
    if (!parsed) return; // 两层都没抽到，不记账（交给模型正常对话回复）

    const self = this;
    wx.cloud.callFunction({
      name: 'miaojiRecord',
      data: {
        action: 'add',
        payload: {
          amount: parsed.amount,
          category: parsed.category,
          note: parsed.note,
        },
      },
    }).then((res) => {
      if (res.result && res.result.success) {
        const sign = parsed.amount < 0 ? '-' : '+';
        const notePart = parsed.note ? `（${parsed.note}）` : '';
        // 确认消息归一为前端代码插入（唯一来源），避免与模型回复重复：
        // - 正则（确定值）：直接确认
        // - 模型降级（模糊值）：带"大概/对吗"让用户核实
        const confirm = source === 'model'
          ? `✅ 已记：<b>${parsed.category}</b> ${sign}¥${Math.abs(parsed.amount)}${notePart}（大概的，对吗？）`
          : `✅ 已记：<b>${parsed.category}</b> ${sign}¥${Math.abs(parsed.amount)}${notePart}`;
        // 在对话流里追加【唯一】记账确认（模型侧已被 systemPrompt 指示不再重复确认）
        const comp = self.selectComponent('#agentui');
        if (comp && comp.appendAssistantMessage) {
          comp.appendAssistantMessage(confirm);
        }
        wx.showToast({ title: '记账成功', icon: 'success' });
      } else {
        wx.showToast({ title: '记账失败', icon: 'none' });
      }
    }).catch((err) => {
      console.error('miaojiRecord add failed', err);
      wx.showToast({ title: '记账出错', icon: 'none' });
    });
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
