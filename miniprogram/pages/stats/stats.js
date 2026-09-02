const api = require('../../utils/api');
const { localDateString } = require('../../utils/srs');
const { toast } = require('../../utils/format');

function addDays(date, delta) {
  const next = new Date(date);
  next.setDate(next.getDate() + delta);
  return next;
}

Page({
  data: {
    stats: { wordCount: 0, dueCount: 0, todayReviews: 0, totalReviews: 0, daily: [] },
    bars: [],
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    try {
      const since = localDateString(addDays(new Date(), -29));
      const stats = await api.stats({ since });
      this.setData({ stats, bars: this.buildBars(stats.daily || []) });
    } catch (err) {
      toast(err.message || '加载统计失败');
    }
  },

  buildBars(daily) {
    const counts = new Map(daily.map((row) => [row.date, row.count]));
    const days = [];
    for (let i = 29; i >= 0; i -= 1) {
      const date = addDays(new Date(), -i);
      const key = localDateString(date);
      days.push({ date: key, day: key.slice(8, 10), count: counts.get(key) || 0 });
    }
    const max = Math.max(1, ...days.map((x) => x.count));
    return days.map((x) => ({ ...x, height: Math.max(6, Math.round((x.count / max) * 180)) }));
  },
});
