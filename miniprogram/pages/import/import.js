const api = require('../../utils/api');
const { buildSentencesPayload } = require('../../utils/pipeline');
const { toast, loading, hideLoading, examTypeLabel } = require('../../utils/format');

const examTypes = [
  { label: '雅思 IELTS', value: 'IELTS' },
  { label: '托福 TOEFL', value: 'TOEFL' },
  { label: 'GRE', value: 'GRE' },
  { label: 'GMAT', value: 'GMAT' },
  { label: 'SAT', value: 'SAT' },
  { label: 'ACT', value: 'ACT' },
  { label: 'AP', value: 'AP' },
  { label: 'A-Level', value: 'A-Level' },
  { label: 'IB', value: 'IB' },
  { label: '高考', value: 'Gaokao' },
  { label: '中考', value: 'Zhongkao' },
  { label: '大学英语四级 CET-4', value: 'CET-4' },
  { label: '大学英语六级 CET-6', value: 'CET-6' },
  { label: '考研英语', value: 'Kaoyan' },
  { label: '专四 TEM-4', value: 'TEM-4' },
  { label: '专八 TEM-8', value: 'TEM-8' },
  { label: '商务英语 BEC', value: 'BEC' },
  { label: '托业 TOEIC', value: 'TOEIC' },
  { label: 'PTE', value: 'PTE' },
  { label: 'Duolingo English Test', value: 'Duolingo' },
  { label: 'LSAT', value: 'LSAT' },
  { label: 'MCAT', value: 'MCAT' },
  { label: '其他', value: 'Other' },
];

const CHUNK = 80;

function putFile(url, arrayBuffer, contentType) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: 'PUT',
      data: arrayBuffer,
      timeout: 300000,
      header: { 'content-type': contentType },
      success: (res) => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(res) : reject(new Error(`上传失败（${res.statusCode}）`))),
      fail: (err) => reject(new Error(err.errMsg === 'request:fail timeout' ? '上传超时，请检查网络后重试' : (err.errMsg || '上传失败'))),
    });
  });
}

function readFileBuffer(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: (res) => resolve(res.data),
      fail: (err) => reject(new Error(err.errMsg || '读取文件失败')),
    });
  });
}

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function contentTypeOf(name) {
  const ext = extOf(name);
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'docx' || ext === 'doc') return 'application/msword';
  return 'application/octet-stream';
}

function baseName(name) {
  return String(name || '').replace(/\.[^.]+$/, '');
}

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

    // ---- 文件导入（MinerU） ----
    fileExamIndex: 0,
    files: [],
    docName: '',
    fileState: 'idle', // idle | uploading | converting | importing | error
    fileProgress: '',
  },

  onShow() {
    this.refreshDocuments();
  },

  // ============ 粘贴文本导入 ============

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
      const inserted = await this.importSentences(sentences, filename, examType);
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

  // ============ 文件导入（MinerU：PDF / Word / 图片 → Markdown） ============

  chooseFile() {
    wx.chooseMessageFile({
      count: 9,
      type: 'file',
      extensions: ['pdf', 'docx', 'doc', 'txt', 'png', 'jpg', 'jpeg', 'webp', 'bmp'],
      success: (res) => this.acceptFiles(res.tempFiles.map((f) => ({ path: f.path, name: f.name, size: f.size }))),
      fail: () => {},
    });
  },

  chooseImage() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = res.tempFiles.map((f, i) => ({
          path: f.tempFilePath,
          name: `image-${i + 1}.png`,
          size: f.size,
        }));
        this.acceptFiles(files);
      },
      fail: () => {},
    });
  },

  acceptFiles(files) {
    if (!files || !files.length) return;
    if (this.data.fileState !== 'idle') {
      toast('正在导入中，请等当前任务结束');
      return;
    }
    const merged = this.data.files.concat(files).slice(0, 9).map((f) => ({
      ...f,
      sizeText: f.size < 1048576 ? `${Math.max(1, Math.round(f.size / 1024))} KB` : `${(f.size / 1048576).toFixed(1)} MB`,
    }));
    this.setData({
      files: merged,
      docName: this.data.docName || baseName(merged[0].name),
      fileState: 'idle',
      fileProgress: '',
    });
  },

  removeFile(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const files = this.data.files.filter((_, i) => i !== idx);
    this.setData({ files, docName: files.length ? this.data.docName : '' });
  },

  onDocNameInput(e) {
    this.setData({ docName: e.detail.value });
  },

  onFileExamChange(e) {
    this.setData({ fileExamIndex: Number(e.detail.value) || 0 });
  },

  async startFileImport() {
    const docName = this.data.docName.trim();
    if (!docName) return toast('请先给这批文件命名');
    if (!this.data.files.length) return toast('请先选择文件');

    try {
      this.setData({ fileState: 'uploading', fileProgress: '正在申请上传地址…' });

      // 1. 申请预签名上传地址
      const urls = await api.mineruRequestUploadUrls({ files: this.data.files.map((f) => ({ name: f.name })) });
      if (!urls.fileUrls || urls.fileUrls.length !== this.data.files.length) {
        throw new Error('MinerU 返回的上传地址数量与文件数不符');
      }

      // 2. 逐个上传（PUT 二进制）
      for (let i = 0; i < this.data.files.length; i++) {
        this.setData({ fileProgress: `上传文件 ${i + 1}/${this.data.files.length}…` });
        const buffer = await readFileBuffer(this.data.files[i].path);
        await putFile(urls.fileUrls[i], buffer, contentTypeOf(this.data.files[i].name));
      }

      // 3. 轮询转换结果
      this.setData({ fileState: 'converting', fileProgress: 'MinerU 解析中，通常 20-90 秒…' });
      const items = await this.pollBatch(urls.batchId);

      // 4. 取每个结果的 markdown
      const texts = [];
      for (let i = 0; i < items.length; i++) {
        this.setData({ fileProgress: `提取全文 ${i + 1}/${items.length}…` });
        const res = await api.mineruExtractText({ url: items[i].fullZipUrl });
        texts.push(res.text);
      }
      const fullText = texts.join('\n\n');
      const sentences = buildSentencesPayload(fullText).map((row, index) => ({ ...row, position: index }));
      if (!sentences.length) throw new Error('MinerU 结果中没有可导入的句子');

      // 5. 建文档 + 索引（与粘贴导入同一管线）
      this.setData({ fileState: 'importing', fileProgress: `建立索引（共 ${sentences.length} 句）…` });
      const examType = examTypes[this.data.fileExamIndex].value;
      const inserted = await this.importSentences(sentences, docName, examType);

      this.setData({ files: [], docName: '', fileState: 'idle', fileProgress: '' });
      await this.refreshDocuments();
      toast(`已导入 ${inserted} 句`, 'success');
    } catch (err) {
      this.setData({ fileState: 'error', fileProgress: err.message || '导入失败' });
    }
  },

  async pollBatch(batchId) {
    const INTERVAL = 5000;
    const MAX_ROUNDS = 60; // 最长约 5 分钟
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await new Promise((r) => setTimeout(r, INTERVAL));
      const res = await api.mineruBatchResult({ batchId });
      const items = res.items || [];
      if (items.length && items.every((it) => it.state === 'done')) return items;
      const failed = items.find((it) => it.state === 'failed');
      if (failed) throw new Error(`MinerU 转换失败：${failed.errMsg || failed.fileName || '未知错误'}`);
      const states = items.length ? items.map((it) => it.state).filter((s) => s !== 'done').join('/') : 'waiting';
      this.setData({ fileProgress: `MinerU 解析中（${states}）…` });
    }
    throw new Error('MinerU 转换超时，请稍后重试');
  },

  async importSentences(sentences, filename, examType) {
    const doc = await api.createDocument({ filename, examType });
    let inserted = 0;
    for (let i = 0; i < sentences.length; i += CHUNK) {
      const res = await api.appendSentences({ documentId: doc.id, sentences: sentences.slice(i, i + CHUNK) });
      inserted += res.inserted || 0;
    }
    return inserted;
  },

  resetFileState() {
    this.setData({ fileState: 'idle', fileProgress: '' });
  },

  async refreshDocuments() {
    try {
      const res = await api.listDocuments();
      const documents = (res.documents || []).map((d) => ({ ...d, examTypeLabel: examTypeLabel(d.examType) }));
      this.setData({ documents });
    } catch (err) {
      console.warn(err);
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
