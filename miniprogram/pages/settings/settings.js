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
      this.setData({
        user: me.user || { isAdmin: false },
        settings,
        protocolIndex,
        form: { ...this.data.form, llmBaseUrl: settings.llmBaseUrl || '', llmModel: settings.llmModel || '' },
      });
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
    wx.setClipboardData({
      data: url,
      success: () => toast('链接已复制，请在浏览器打开', 'none'),
    });
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
