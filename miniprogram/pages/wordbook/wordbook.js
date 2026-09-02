const api = require('../../utils/api');
const { isDueWord, localDateString } = require('../../utils/srs');
const { toast, familiarityLabel, shortDate } = require('../../utils/format');

Page({
  data: {
    words: [],
    visibleWords: [],
    dueCount: 0,
    filter: 'all',
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    try {
      const res = await api.listWordbook();
      const today = localDateString();
      const words = (res.words || []).map((item) => ({
        ...item,
        familiarityLabel: familiarityLabel(item.familiarity),
        nextDate: item.nextReviewAt ? shortDate(item.nextReviewAt) : '今日',
        due: isDueWord(item, today),
      }));
      this.setData({ words, dueCount: res.dueCount || 0 }, () => this.applyFilter());
    } catch (err) {
      toast(err.message || '加载失败');
    }
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.filter }, () => this.applyFilter());
  },

  applyFilter() {
    const filter = this.data.filter;
    let visibleWords = this.data.words.slice();
    if (filter === 'weak') visibleWords = visibleWords.filter((x) => Number(x.familiarity || 0) <= 2);
    if (filter === 'normal') visibleWords = visibleWords.filter((x) => Number(x.familiarity || 0) >= 3 && Number(x.familiarity || 0) <= 4);
    if (filter === 'known') visibleWords = visibleWords.filter((x) => Number(x.familiarity || 0) >= 5);
    if (filter === 'due') visibleWords = visibleWords.filter((x) => x.due);
    visibleWords.sort((a, b) => Number(a.familiarity || 0) - Number(b.familiarity || 0) || String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
    this.setData({ visibleWords });
  },

  goReview() {
    wx.navigateTo({ url: '/pages/review/review' });
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
