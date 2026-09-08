const api = require('../../utils/api');
const { toast } = require('../../utils/format');

const protocols = [
  { label: 'OpenAI 兼容', value: 'openai', desc: '请求 {Base URL}/chat/completions，适用于 OpenAI、DeepSeek、智谱、Kimi、通义等绝大多数服务商。' },
  { label: 'Anthropic', value: 'anthropic', desc: '请求 {Base URL}/v1/messages，适用于 Anthropic Claude 官方及兼容接口。' },
];

Page({
  data: {
    user: { isAdmin: false },
    settings: {},
    protocols,
    protocolIndex: 0,
    modelOptions: [],
    modelIndex: -1,
    loadingModels: false,
    form: { llmBaseUrl: '', llmModel: '', llmApiKey: '', mineruApiToken: '' },
    saving: false,
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    try {
      const me = await api.initUser();
      const settings = await api.getSettings();
      const protocolIndex = Math.max(0, protocols.findIndex((p) => p.value === (settings.llmProtocol || 'openai')));
      const modelOptions = settings.llmModel ? [settings.llmModel] : [];
      const patch = {
        user: me.user || { isAdmin: false },
        settings,
        protocolIndex,
        modelOptions,
        modelIndex: modelOptions.length ? 0 : -1,
      };
      // 首次才把服务端值灌进表单：避免切 tab 回来覆盖用户正在编辑的内容
      if (!this._formLoaded) {
        patch.form = { ...this.data.form, llmBaseUrl: settings.llmBaseUrl || '', llmModel: settings.llmModel || '' };
        this._formLoaded = true;
      }
      this.setData(patch);
    } catch (err) {
      toast(err.message || '加载失败');
    }
  },

  onProtocolChange(e) {
    this.setData({ protocolIndex: Number(e.detail.value) || 0 });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  copyLink(e) {
    const url = e.currentTarget.dataset.url;
    wx.showModal({
      title: '复制链接到浏览器打开',
      content: `微信小程序不能直接打开外部浏览器。点击「复制」后，到手机浏览器粘贴访问：\n${url}`,
      confirmText: '复制',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        wx.setClipboardData({
          data: url,
          success: () => toast('链接已复制', 'success'),
          fail: () => {
            wx.showModal({ title: '复制失败，请手动复制', content: url, showCancel: false, confirmText: '知道了' });
          },
        });
      },
    });
  },

  async loadModels() {
    const { llmBaseUrl, llmApiKey } = this.data.form;
    if (!llmBaseUrl || (!llmApiKey && !this.data.settings.llmKeySet)) {
      toast('请先填写 Base URL 和 API Key');
      return;
    }
    this.setData({ loadingModels: true });
    try {
      const protocol = protocols[this.data.protocolIndex].value;
      const { models } = await api.llmModels({ llmProtocol: protocol, llmBaseUrl, llmApiKey });
      const current = this.data.form.llmModel;
      const modelIndex = current ? models.indexOf(current) : (models.length ? 0 : -1);
      this.setData({
        modelOptions: models,
        modelIndex: modelIndex >= 0 ? modelIndex : 0,
        'form.llmModel': current && models.includes(current) ? current : (models[0] || ''),
      });
      toast(`已拉取 ${models.length} 个模型`, 'success');
    } catch (err) {
      toast(err.message || '拉取模型失败');
    } finally {
      this.setData({ loadingModels: false });
    }
  },

  onModelChange(e) {
    const idx = Number(e.detail.value) || 0;
    const model = this.data.modelOptions[idx] || '';
    this.setData({ modelIndex: idx, 'form.llmModel': model });
  },

  async save() {
    this.setData({ saving: true });
    try {
      const protocol = protocols[this.data.protocolIndex].value;
      await api.saveSettings({ ...this.data.form, llmProtocol: protocol });
      this.setData({ 'form.llmApiKey': '', 'form.mineruApiToken': '' });
      await this.refresh();
      toast('已保存', 'success');
    } catch (err) {
      toast(err.message || '保存失败');
    } finally {
      this.setData({ saving: false });
    }
  },
});
