const api = require('../../utils/api');
const { toast } = require('../../utils/format');

const examTypes = [
  { label: '全部考试', value: 'All' },
  { label: 'IELTS', value: 'IELTS' },
  { label: 'TOEFL', value: 'TOEFL' },
  { label: 'GRE', value: 'GRE' },
  { label: '其他', value: 'Other' },
];

Page({
  data: {
    examTypes,
    examIndex: 0,
    word: '',
    loading: false,
    searched: false,
    suggestions: [],
    result: {},
    sentences: [],
  },

  onWordInput(e) {
    const word = e.detail.value;
    this.setData({ word });
    clearTimeout(this.suggestTimer);
    if (word.trim().length < 2) {
      this.setData({ suggestions: [] });
      return;
    }
    this.suggestTimer = setTimeout(() => this.refreshSuggest(word), 220);
  },

  onExamChange(e) {
    this.setData({ examIndex: Number(e.detail.value) || 0 });
    if (this.data.word.trim()) this.submit();
  },

  async refreshSuggest(prefix) {
    try {
      const examType = examTypes[this.data.examIndex].value;
      const res = await api.suggest({ prefix, examType });
      this.setData({ suggestions: res.suggestions || [] });
    } catch (err) {
      console.warn(err);
    }
  },

  pickSuggestion(e) {
    const word = e.currentTarget.dataset.word;
    this.setData({ word, suggestions: [] });
    this.submit();
  },

  async submit() {
    const word = this.data.word.trim();
    if (!word) return toast('请输入单词');
    this.setData({ loading: true, searched: true, suggestions: [] });
    try {
      const examType = examTypes[this.data.examIndex].value;
      const result = await api.search({ word, examType });
      this.setData({ result, sentences: result.sentences || [] });
    } catch (err) {
      toast(err.message || '查询失败');
    } finally {
      this.setData({ loading: false });
    }
  },

  async collectWord() {
    if (!this.data.result.word) return;
    try {
      await api.addWordbook({ word: this.data.result.word });
      toast('已加入生词本', 'success');
      this.submit();
    } catch (err) {
      toast(err.message || '收录失败');
    }
  },

  async collectSentence(e) {
    if (!this.data.result.word) return;
    try {
      await api.addWordbook({ word: this.data.result.word, sentenceId: e.currentTarget.dataset.id });
      toast('已收录例句', 'success');
      this.submit();
    } catch (err) {
      toast(err.message || '收录失败');
    }
  },
});
