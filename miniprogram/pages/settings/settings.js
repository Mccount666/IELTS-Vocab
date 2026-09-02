const api = require('../../utils/api');
const { toast } = require('../../utils/format');

Page({
  data: {
    user: { isAdmin: false },
    settings: {},
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
      this.setData({
        user: me.user || { isAdmin: false },
        settings,
        form: { ...this.data.form, llmBaseUrl: settings.llmBaseUrl || '', llmModel: settings.llmModel || '' },
      });
    } catch (err) {
      toast(err.message || '加载失败');
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  async save() {
    this.setData({ saving: true });
    try {
      await api.saveSettings(this.data.form);
      this.setData({ 'form.llmApiKey': '', 'form.mineruApiToken': '' });
      await this.refresh();
      toast('已保存', 'success');
    } catch (err) {
      toast(err.message || '保存失败');
    } finally {
      this.setData({ saving: false });
    }
  },

  goStats() {
    wx.navigateTo({ url: '/pages/stats/stats' });
  },
});
