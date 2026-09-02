const api = require('../../utils/api');
const { toast } = require('../../utils/format');

Page({
  data: {
    docCount: 0,
    wordCount: 0,
    error: '',
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    try {
      await api.initUser();
      const [docs, wb] = await Promise.all([api.listDocuments(), api.listWordbook()]);
      this.setData({
        docCount: (docs.documents || []).length,
        wordCount: (wb.words || []).length,
        error: '',
      });
    } catch (err) {
      console.warn(err);
      const raw = err.errMsg || err.message || '';
      const friendly = raw.includes('Cloud API') || raw.includes('cloud')
        ? '云服务暂时不可用，请稍后下拉刷新重试'
        : raw || '初始化失败，请稍后重试';
      this.setData({ error: friendly });
    }
  },

  goSearch() {
    wx.switchTab({ url: '/pages/search/search' });
  },

  goImport() {
    wx.switchTab({ url: '/pages/import/import' });
  },
});
