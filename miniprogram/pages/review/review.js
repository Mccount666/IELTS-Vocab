const api = require('../../utils/api');
const { isDueWord, localDateString } = require('../../utils/srs');
const { toast } = require('../../utils/format');

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

Page({
  data: {
    queue: [],
    index: 0,
    current: null,
    showAnswer: false,
    finished: false,
    mode: 'word',
  },

  onLoad() {
    this.reload();
  },

  async reload() {
    try {
      const res = await api.listWordbook();
      const today = localDateString();
      const queue = (res.words || [])
        .filter((x) => isDueWord(x, today))
        .sort((a, b) => Number(a.familiarity || 0) - Number(b.familiarity || 0));
      this.setData({ queue, index: 0, finished: false }, () => this.setCurrent());
    } catch (err) {
      toast(err.message || '加载失败');
    }
  },

  async setCurrent() {
    const current = this.data.queue[this.data.index] || null;
    if (!current) {
      this.setData({ current: null, finished: this.data.queue.length > 0, showAnswer: false });
      return;
    }
    let sentenceText = '';
    if (current.sentenceId) {
      try {
        const res = await api.getSentence({ id: current.sentenceId });
        if (res.sentence && res.sentence.text) sentenceText = res.sentence.text;
      } catch (err) {
        console.warn(err);
      }
    }
    const pattern = new RegExp(`\\b${escapeRegExp(current.word)}\\b`, 'ig');
    const clozeText = sentenceText ? sentenceText.replace(pattern, '____') : '';
    this.setData({ current: { ...current, sentenceText, clozeText }, mode: sentenceText ? 'cloze' : 'word', showAnswer: false });
  },

  flip() {
    this.setData({ showAnswer: true });
  },

  async grade(e) {
    if (!this.data.current) return;
    try {
      await api.reviewWordbook({ id: this.data.current._id, grade: e.currentTarget.dataset.grade });
      this.setData({ index: this.data.index + 1 }, () => this.setCurrent());
    } catch (err) {
      toast(err.message || '评分失败');
    }
  },
});
