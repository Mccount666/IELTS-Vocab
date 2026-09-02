const api = require('../../utils/api');
const { toast, shortDate } = require('../../utils/format');

Page({
  data: {
    words: [],
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    try {
      const res = await api.listWordbook();
      const words = (res.words || []).map((item) => ({
        ...item,
        addedDate: shortDate(item.addedAt),
      }));
      this.setData({ words });
    } catch (err) {
      toast(err.message || '加载失败');
    }
  },

  deleteWord(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除生词',
      content: '确定从生词本移除吗？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.deleteWordbook({ id });
          await this.refresh();
          toast('已删除', 'success');
        } catch (err) {
          toast(err.message || '删除失败');
        }
      },
    });
  },
});
