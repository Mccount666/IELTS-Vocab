const api = require('../../utils/api');
const { lemmatize } = require('../../utils/pipeline');
const { toast } = require('../../utils/format');

const examTypes = [
  { label: '全部考试', value: 'All' },
  { label: 'IELTS', value: 'IELTS' },
  { label: 'TOEFL', value: 'TOEFL' },
  { label: 'GRE', value: 'GRE' },
  { label: '其他', value: 'Other' },
];

const HISTORY_KEY = 'iv_recent_words';

function loadHistory() {
  try {
    const list = wx.getStorageSync(HISTORY_KEY);
    return Array.isArray(list) ? list.slice(0, 10) : [];
  } catch (e) {
    return [];
  }
}

// 把例句拆成 {t, hl} 片段：命中目标词/词形/短语 token 的片段高亮
function highlightParts(text, terms, lemma) {
  const set = new Set((terms || []).filter(Boolean));
  const parts = String(text || '').split(/([^A-Za-z']+)/).filter((s) => s !== '');
  return parts.map((t) => {
    const low = t.toLowerCase();
    const hl = set.has(low) || (lemma && lemmatize(low) === lemma);
    return { t, hl };
  });
}

Page({
  data: {
    examTypes,
    examIndex: 0,
    word: '',
    loading: false,
    searched: false,
    suggestions: [],
    history: [],
    result: {},
    sentences: [],
    sentenceViews: [],
    dict: null,
    dictLoading: false,
    dictMode: '',
    translations: {},
    nearWords: [],
  },

  onLoad() {
    this.setData({ history: loadHistory() });
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

  pickHistory(e) {
    const word = e.currentTarget.dataset.word;
    this.setData({ word, suggestions: [] });
    this.submit();
  },

  clearHistory() {
    try { wx.removeStorageSync(HISTORY_KEY); } catch (e) { /* 忽略存储异常 */ }
    this.setData({ history: [] });
    toast('已清空历史', 'none');
  },

  pushHistory(word) {
    let list = loadHistory();
    list = [word, ...list.filter((w) => w !== word)].slice(0, 10);
    try { wx.setStorageSync(HISTORY_KEY, list); } catch (e) { /* 忽略存储异常 */ }
    this.setData({ history: list });
  },

  async submit() {
    const word = this.data.word.trim().toLowerCase();
    if (!word) return toast('请输入单词');
    this.setData({ loading: true, searched: true, suggestions: [], dict: null, dictMode: '', translations: {} });
    try {
      const examType = examTypes[this.data.examIndex].value;
      const result = await api.search({ word, examType });
      const terms = result.terms && result.terms.length ? result.terms : [result.word, result.lemma];
      const sentenceViews = (result.sentences || []).map((s) => ({
        ...s,
        parts: highlightParts(s.text, terms, result.lemma),
        sourceLabel: s.documentFilename ? `${s.documentFilename} · 位置 ${s.position + 1}` : `位置 ${s.position + 1}`,
      }));
      this.setData({ result, sentences: result.sentences || [], sentenceViews, nearWords: [] });
      this.pushHistory(word);
      this.loadDict(word);
      // 查不到例句时，用真题词表推荐相近词
      if (!result.sentences || !result.sentences.length) {
        try {
          const near = await api.suggest({ prefix: word.slice(0, Math.max(2, word.length)), examType });
          this.setData({ nearWords: (near.suggestions || []).filter((s) => s.word !== word).slice(0, 6) });
        } catch (err) { /* 静默，不影响主流程 */ }
      }
    } catch (err) {
      toast(err.message || '查询失败');
    } finally {
      this.setData({ loading: false });
    }
  },

  // 释义卡：先免费词典；未命中且有 LLM Key 时自动 AI 释义，都失败留按钮
  async loadDict(word) {
    this.setData({ dictLoading: true, dict: null, dictMode: '' });
    let dict = null;
    let mode = '';
    try {
      const free = await api.dictionaryLookup({ word });
      if (free && !free.notFound) {
        dict = free;
        mode = 'free';
      }
    } catch (err) {
      console.warn('free dict failed:', err.errMsg || err.message);
    }
    if (!dict) {
      try {
        const ai = await api.llmDefine({ word });
        dict = ai;
        mode = 'llm';
      } catch (err) {
        console.warn('ai define unavailable:', err.errMsg || err.message);
      }
    }
    this.setData({ dict, dictMode: mode, dictLoading: false });
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
