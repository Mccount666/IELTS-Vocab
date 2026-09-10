const api = require('../../utils/api');
const { toast, examTypeLabel } = require('../../utils/format');

Page({
  data: {
    documents: [],
    loading: false,
    current: null,
  },

  onShow() {
    if (!this.data.current) this.load();
  },

  onPullDownRefresh() {
    this.load(true);
  },

  async load(fromPull = false) {
    this.setData({ loading: true });
    try {
      const res = await api.listDocuments();
      const documents = (res.documents || []).map((d) => ({ ...d, examTypeLabel: examTypeLabel(d.examType) }));
      this.setData({ documents });
    } catch (e) {
      toast(e.message || '加载失败');
    }
    this.setData({ loading: false });
    if (fromPull) wx.stopPullDownRefresh();
  },

  async openDoc(e) {
    const { id } = e.currentTarget.dataset;
    try {
      const res = await api.listSentences({ documentId: id });
      this.setData({
        current: {
          filename: res.document.filename,
          content: res.document.content || '',
          sentences: res.sentences,
        },
      });
      wx.setNavigationBarTitle({ title: res.document.filename || '文库' });
    } catch (err) {
      toast(err.message || '加载失败');
    }
  },

  closeDoc() {
    this.setData({ current: null });
    wx.setNavigationBarTitle({ title: '文库' });
  },
});
