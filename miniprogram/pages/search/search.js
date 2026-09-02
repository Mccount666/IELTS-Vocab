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
    dict: null,
    dictLoading: false,
    dictMode: '',
    translations: {},
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
    this.setData({ loading: true, searched: true, suggestions: [], dict: null, dictMode: '', translations: {} });
    try {
      const examType = examTypes[this.data.examIndex].value;
      const result = await api.search({ word, examType });
      this.setData({ result, sentences: result.sentences || [] });
      this.loadDict(word);
    } catch (err) {
      toast(err.message || '查询失败');
    } finally {
      this.setData({ loading: false });
    }
  },

  // 释义卡：优先免费词典（无需 Key），LLM 释义按需点按钮
  async loadDict(word) {
    this.setData({ dictLoading: true, dict: null, dictMode: '' });
    try {
      const dict = await api.dictionaryLookup({ word });
      if (dict && !dict.notFound) {
        this.setData({ dict, dictMode: 'free' });
      }
    } catch (err) {
      console.warn(err);
    } finally {
      this.setData({ dictLoading: false });
    }
  },

  async aiDefine() {
    if (!this.data.result.word) return;
    this.setData({ dictLoading: true });
    try {
      const dict = await api.llmDefine({ word: this.data.result.word });
      this.setData({ dict, dictMode: 'llm' });
    } catch (err) {
      toast(err.message || 'AI 释义失败');
    } finally {
      this.setData({ dictLoading: false });
    }
  },

  async translateSentence(e) {
    const id = e.currentTarget.dataset.id;
    const text = e.currentTarget.dataset.text;
    if (!text || this.data.translations[id]) return;
    this.setData({ [`translations.${id}`]: '…' });
    try {
      const res = await api.llmTranslate({ text });
      this.setData({ [`translations.${id}`]: res.translation || '' });
    } catch (err) {
      this.setData({ [`translations.${id}`]: '' });
      toast(err.message || '翻译失败');
    }
  },

  async collectWord() {
    if (!this.data.result.word) return;
    try {
      const dict = this.data.dict || {};
      await api.addWordbook({
        word: this.data.result.word,
        phonetic: dict.phonetic || '',
        translation: dict.translation || '',
        definition: dict.definition || '',
      });
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
