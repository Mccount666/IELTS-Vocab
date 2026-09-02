const api = require('../../utils/api');
const { localDateString } = require('../../utils/srs');

Page({
  data: {
    stats: { wordCount: 0, dueCount: 0, todayReviews: 0 },
    error: '',
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    try {
      await api.initUser();
      const stats = await api.stats({ since: localDateString(new Date(Date.now() - 29 * 86400000)) });
      this.setData({ stats, error: '' });
    } catch (err) {
      console.warn(err);
      this.setData({ error: err.errMsg || err.message || '初始化失败' });
    }
  },

  goSearch() {
    wx.switchTab({ url: '/pages/search/search' });
  },

  goImport() {
    wx.switchTab({ url: '/pages/import/import' });
  },
});
