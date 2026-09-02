function call(action, data = {}) {
  return wx.cloud.callFunction({
    name: 'api',
    data: { action, data },
  }).then((res) => {
    const result = res.result || {};
    if (!result.ok) {
      throw new Error(result.error || '请求失败');
    }
    return result.data || {};
  });
}

module.exports = {
  initUser: () => call('me.initUser'),
  listDocuments: () => call('documents.list'),
  createDocument: (data) => call('documents.create', data),
  deleteDocument: (data) => call('documents.delete', data),
  appendSentences: (data) => call('documents.appendSentences', data),
  getSentence: (data) => call('sentences.get', data),
  search: (data) => call('search.query', data),
  suggest: (data) => call('search.suggest', data),
  context: (data) => call('search.context', data),
  listWordbook: (data) => call('wordbook.list', data),
  addWordbook: (data) => call('wordbook.add', data),
  deleteWordbook: (data) => call('wordbook.delete', data),
  reviewWordbook: (data) => call('wordbook.review', data),
  batchWordbook: (data) => call('wordbook.batch', data),
  stats: (data) => call('stats.get', data),
  getSettings: () => call('settings.get'),
  saveSettings: (data) => call('settings.save', data),
};
