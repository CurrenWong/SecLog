// pages/chatBot/chatBot.js
// 秒记记账对话：chatMode 用 model（直连大模型，忽略 Agent/bot）
// 记账逻辑完全在前端：监听 agent-ui 的 userSend 事件拿用户输入，
// 解析消费信息，调用 miaojiRecord 云函数写入数据库，并在对话里追加记账确认。
// 混合抽取：正则（parseExpense）命中即记；完全抽不到时降级调大模型（extractByModel）。
const { parseExpense } = require('../../utils/parseExpense')
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
    // 系统提示词：让直连大模型具备"秒记记账助手"人设，避免对消费语句展开冗余分析
    systemPrompt: "你是秒记，一款AI记账助手。规则：1) 当用户说出一笔消费或收入（如'午饭38''打车45''收到工资8000'），你只需用一句话简短确认已记下，不要展开分析、不要反问、不要给建议；2) 若用户只是闲聊或提问，正常简洁回答；3) 始终用中文，口语化，不超过两句话。",
    envShareConfig: null,
  },

  // 用户输入发送时触发（agent-ui 抛出）
  onUserSend(e) {
    const text = (e.detail && e.detail.content) || '';
    this.tryRecord(text, true);
  },

  // 兼容：模型回复结束也可触发（用模型回复兜底解析，但优先用户原话）
  onMessageDone(e) {
    // 此处不重复记账，记账以用户原话为准（onUserSend）
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

  // 解析消费文本并记账。混合策略：正则优先，模型兜底。
  async tryRecord(text) {
    if (!text) return;
    let parsed = parseExpense(text) // 正则（快/免费/确定）
    if (!parsed) {
      // 正则完全抽不到 → 降级调大模型
      try {
        parsed = await extractByModel(text, (prompt) => this.callModelForExtract(prompt))
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
        const msg = `✅ 已记：<b>${parsed.category}</b> ${sign}¥${Math.abs(parsed.amount)}${parsed.note ? '（' + parsed.note + '）' : ''}`;
        // 在对话流里追加记账确认
        const comp = self.selectComponent('#agentui');
        if (comp && comp.appendAssistantMessage) {
          comp.appendAssistantMessage(msg);
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
