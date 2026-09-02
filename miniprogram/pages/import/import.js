const api = require('../../utils/api');
const { buildSentencesPayload } = require('../../utils/pipeline');
const { toast, loading, hideLoading } = require('../../utils/format');

const examTypes = [
  { label: 'IELTS', value: 'IELTS' },
  { label: 'TOEFL', value: 'TOEFL' },
  { label: 'GRE', value: 'GRE' },
  { label: '其他', value: 'Other' },
];

Page({
  data: {
    examTypes,
    examIndex: 0,
    filename: '',
    text: '',
    sentenceCount: 0,
    tokenCount: 0,
    submitting: false,
    documents: [],
  },

  onShow() {
    this.refreshDocuments();
  },

  onFilenameInput(e) {
    this.setData({ filename: e.detail.value });
  },

  onTextInput(e) {
    const text = e.detail.value;
    const sentences = buildSentencesPayload(text);
    const tokenCount = sentences.reduce((sum, s) => sum + s.tokens.length, 0);
    this.setData({ text, sentenceCount: sentences.length, tokenCount });
  },

  onExamChange(e) {
    this.setData({ examIndex: Number(e.detail.value) || 0 });
  },

  async refreshDocuments() {
    try {
      const res = await api.listDocuments();
      this.setData({ documents: res.documents || [] });
    } catch (err) {
      console.warn(err);
    }
  },

  async submit() {
    const filename = this.data.filename.trim();
    const text = this.data.text.trim();
    if (!filename) return toast('请填写文档名称');
    if (!text) return toast('请粘贴文本');
    const sentences = buildSentencesPayload(text).map((row, index) => ({ ...row, position: index }));
    if (!sentences.length) return toast('没有识别到句子');

    this.setData({ submitting: true });
    loading('正在导入');
    try {
      const examType = examTypes[this.data.examIndex].value;
      const doc = await api.createDocument({ filename, examType });
      const chunkSize = 80;
      let inserted = 0;
      for (let i = 0; i < sentences.length; i += chunkSize) {
        const chunk = sentences.slice(i, i + chunkSize);
        const res = await api.appendSentences({ documentId: doc.id, sentences: chunk });
        inserted += res.inserted || 0;
      }
      this.setData({ filename: '', text: '', sentenceCount: 0, tokenCount: 0 });
      await this.refreshDocuments();
      toast(`已导入 ${inserted} 句`, 'success');
    } catch (err) {
      toast(err.message || '导入失败');
    } finally {
      hideLoading();
      this.setData({ submitting: false });
    }
  },

  deleteDoc(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除文档',
      content: '删除后会同时移除该文档的句子索引。',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.deleteDocument({ documentId: id });
          await this.refreshDocuments();
          toast('已删除', 'success');
        } catch (err) {
          toast(err.message || '删除失败');
        }
      },
    });
  },
});
