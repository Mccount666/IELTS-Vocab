const api = require('../../utils/api');
const { localDateString } = require('../../utils/srs');
const { toast } = require('../../utils/format');

Page({
  data: {
    stats: { wordCount: 0, dueCount: 0, todayReviews: 0 },
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    try {
      await api.initUser();
      const stats = await api.stats({ since: localDateString(new Date(Date.now() - 29 * 86400000)) });
      this.setData({ stats });
    } catch (err) {
      console.warn(err);
      toast(err.message || '初始化失败，请检查云开发环境');
    }
  },

  goSearch() {
    wx.switchTab({ url: '/pages/search/search' });
  },

  goImport() {
    wx.switchTab({ url: '/pages/import/import' });
  },
});
