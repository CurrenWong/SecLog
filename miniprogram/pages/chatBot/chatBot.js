// pages/chatBot/chatBot.js
// 秒记记账对话：chatMode 用 model（直连大模型，忽略 Agent/bot）
// 记账逻辑完全在前端：监听 agent-ui 的 messageDone 事件，
// 解析模型回复里的消费信息，调用 miaojiRecord 云函数写入数据库。
Page({
  data: {
    chatMode: "model", // model：直连大模型（cloudbase/hy3），不依赖 Agent
    showBotAvatar: true,
    agentConfig: {
      // model 模式下 botId 非必填，保留空结构以兼容组件
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
      modelProvider: "cloudbase", // 大模型服务厂商
      quickResponseModel: "hy3", // 具体模型
      logo: "",
      welcomeMsg: "你好，我是秒记 💡 说出你的消费，我来帮你记。例如：午饭花了38块",
    },
    envShareConfig: null,
  },

  // agent-ui 在 model 模式流式结束后抛出模型最终回复
  onMessageDone(e) {
    const content = (e.detail && e.detail.content) || '';
    this.tryRecord(content);
  },

  // 解析消费文本并记账
  tryRecord(text) {
    if (!text) return;
    const parsed = this.parseExpense(text);
    if (!parsed) return; // 不是记账意图，忽略

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
        wx.showToast({
          title: `已记：${parsed.category} ${parsed.amount < 0 ? '' : '+'}${parsed.amount}`,
          icon: 'success',
        });
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
    // 收支意图：先判断是收入还是支出
    const isIncome = /(收入|工资|赚|收|到账|奖金|报销|分红)/i.test(text);

    // 金额：支持 "38块" "38元" "38.5" "-38" "花了38" 等
    // 优先匹配带消费/收入动词的金额，其次带单位，最后纯数字
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

    // 最终金额：收入取正，支出取负（默认支出）
    const amount = isIncome ? Math.abs(raw) : -Math.abs(raw);

    // 分类：根据关键词推断（收入统一归"收入"类便于统计）
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

    // 备注：去掉金额部分后的简短描述（取前 20 字）
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
