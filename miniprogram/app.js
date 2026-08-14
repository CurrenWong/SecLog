// app.js

App({
  globalData: {
    userInfo: null, // { openid, unionid, avatarUrl, nickName, registeredAt }
    // 小程序前端版本号（与 ci-tools/.env 的 VERSION 保持一致，发版时同步修改）
    // 用于在页面上展示，方便真机扫码核验体验版是否为目标版本
    version: '1.4.4',
  },

  onLaunch: function () {
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        env: "seclog-d1g8no5pc45e643aa",
        traceUser: true,
      });
    }
    // 静默登录：拿 openid/unionid 存本地，用户无感。后端已按 openid 隔离数据。
    this.silentLogin();
  },

  // 静默自动登录（持久：存 storage，重进自动续；清缓存后重进会自动重新登录同一微信）
  silentLogin: function () {
    const cached = wx.getStorageSync('userInfo');
    if (cached && cached.openid) {
      this.globalData.userInfo = cached;
      return Promise.resolve(cached);
    }
    return new Promise((resolve) => {
      wx.login({
        success: () => {
          wx.cloud.callFunction({
            name: 'miaojiRecord',
            data: { action: 'login' },
          }).then((res) => {
            if (res.result && res.result.success) {
              const info = {
                openid: res.result.openid,
                unionid: res.result.unionid || '',
                avatarUrl: res.result.avatarUrl || '',
                nickName: res.result.nickName || '',
                registeredAt: res.result.registeredAt || null,
              };
              wx.setStorageSync('userInfo', info);
              this.globalData.userInfo = info;
              resolve(info);
            } else {
              console.error('login failed', res.result);
              resolve(null);
            }
          }).catch((err) => {
            console.error('login callFunction failed', err);
            resolve(null);
          });
        },
        fail: (err) => {
          console.error('wx.login failed', err);
          resolve(null);
        },
      });
    });
  },

  // 退出登录：清本地身份（重进会自动重新静默登录同一微信，数据不丢）
  logout: function () {
    wx.removeStorageSync('userInfo');
    this.globalData.userInfo = null;
  },
});
