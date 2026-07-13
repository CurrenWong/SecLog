// pages/chatBot/chatBot.js
// 秒记记账对话：chatMode 用 model（直连大模型，忽略 Agent/bot）
// 记账逻辑完全在前端：监听 agent-ui 的 userSend 事件拿用户输入，
// 解析消费信息，调用 miaojiRecord 云函数写入数据库，并在对话里追加记账确认。
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

  // 解析消费文本并记账。useUserText=true 时 note 取用户原话
  tryRecord(text) {
    if (!text) return;
    const parsed = this.parseExpense(text);
    if (!parsed) return; // 不是记账意图，忽略

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

  // 从文本提取消费信息。返回 {amount, category, note} 或 null
  parseExpense(text) {
    const isIncome = /(收入|工资|赚|收|到账|奖金|报销|分红)/i.test(text);
    const amountPatterns = [
      /(?:花|支|付|买|消费|支出|付了|花了|用了|请客|喝|吃|打车|收到|赚|挣|报销)[^0-9\-]*?(-?\d+(?:\.\d+)?)\s*(?:元|块|刀|rmb)?/i,
      /(-?\d+(?:\.\d+)?)\s*(?:元|块|刀|rmb)/i,
      /(-?\d+(?:\.\d+)?)/,
    ];
    let raw = null;
    for (const p of amountPatterns) {
      const m = text.match(p);
      if (m) { raw = parseFloat(m[1]); break; }
    }
    if (raw === null || isNaN(raw)) return null;

    const amount = isIncome ? Math.abs(raw) : -Math.abs(raw);

    if (isIncome) {
      return { amount, category: '收入', note: text.replace(/[-+]?\d+(?:\.\d+)?\s*(?:元|块|刀|rmb)?/i, '').trim().slice(0, 20) };
    }
    const categoryMap = [
      { keys: ['午饭', '午餐', '早饭', '早餐', '晚饭', '晚餐', '饭', '吃', '餐', '喝', '奶茶', '咖啡', '餐厅'], cat: '餐饮' },
      { keys: ['打车', '地铁', '公交', '车', '油', '停车', '高铁', '火车', '飞机', '机票', '滴滴'], cat: '交通' },
      { keys: ['买', '购', '衣服', '鞋', '包', '数码', '手机', '电脑', '淘宝', '京东', '超市'], cat: '购物' },
      { keys: ['房租', '水电', '物业', '家居', '家具', '日用品'], cat: '居家' },
      { keys: ['电影', '游戏', '娱乐', '唱k', 'ktv', '旅游', '玩'], cat: '娱乐' },
      { keys: ['药', '医', '医院', '诊所', '体检'], cat: '医疗' },
      { keys: ['书', '课', '培训', '学费', '教育'], cat: '教育' },
    ];
    let category = '其他';
    for (const item of categoryMap) {
      if (item.keys.some((k) => text.includes(k))) { category = item.cat; break; }
    }

    // note 取用户原话去掉金额后的简短描述
    const note = text.replace(/[-+]?\d+(?:\.\d+)?\s*(?:元|块|刀|rmb)?/i, '').trim().slice(0, 20);

    return { amount, category, note };
  },

  onLoad(options) {},
  onReady() {},
  onShow() {},
  onHide() {},
  onUnload() {},
  onPullDownRefresh() {},
  onReachBottom() {},
  onShareAppMessage() {},
});
