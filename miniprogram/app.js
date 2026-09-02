const ENV_ID = 'english-vocab-d9ghjip4scca572d9';

App({
  globalData: {
    envId: ENV_ID,
    user: null,
  },

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '初始化失败',
        content: '当前微信版本不支持云开发，请升级微信。',
        showCancel: false,
      });
      return;
    }

    wx.cloud.init({
      env: ENV_ID,
      traceUser: true,
    });
  },
});
