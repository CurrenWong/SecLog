// pages/chatBot/chatBot.js
Page({
  /**
   * 页面的初始数据
   */
  data: {
    // 秒记记账对话：使用 bot（agent）模式，由 CloudBase Agent 调用 miaojiRecord 云函数完成记账
    chatMode: "bot", // bot: agent 模式（对接秒记记账 agent）；model：直连大模型
    showBotAvatar: true, // 是否在对话框左侧显示头像
    agentConfig: {
      botId: "bot-e7d1e736", // 秒记记账 Agent ID（在 CloudBase 后台为该 bot 配置 miaojiRecord 工具）
      allowWebSearch: false, // 记账场景无需联网搜索
      allowUploadFile: false, // 暂不开文件上传（后续可开启小票识别）
      allowPullRefresh: true, // 允许下拉刷新
      allowUploadImage: true, // 允许上传图片（拍照记账：小票识别）
      showToolCallDetail: false, // 对终端用户隐藏 toolCall 细节
      allowMultiConversation: true, // 允许多轮对话
      allowVoice: true, // 允许语音输入（说话记账）
      showBotName: true, // 展示 bot 名称
      welcomeMsg: "你好，我是秒记 💡 说出你的消费，我来帮你记。例如：午饭花了38块",
    },
    modelConfig: {
      modelProvider: "cloudbase",
      quickResponseModel: "hy3",
      logo: "",
      welcomeMsg: "你好，我是秒记 💡 说出你的消费，我来帮你记。",
    },
  },
  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {},

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {},

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {},

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {},

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {},

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh() {},

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {},

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {},
});
