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
  search: (data) => call('search.query', data),
  suggest: (data) => call('search.suggest', data),
  context: (data) => call('search.context', data),
  listWordbook: (data) => call('wordbook.list', data),
  addWordbook: (data) => call('wordbook.add', data),
  deleteWordbook: (data) => call('wordbook.delete', data),
  getSettings: () => call('settings.get'),
  saveSettings: (data) => call('settings.save', data),
  llmModels: (data) => call('llm.models', data),
  llmDefine: (data) => call('llm.define', data),
  llmTranslate: (data) => call('llm.translate', data),
  dictionaryLookup: (data) => call('dictionary.lookup', data),
  mineruRequestUploadUrls: (data) => call('mineru.requestUploadUrls', data),
  mineruBatchResult: (data) => call('mineru.batchResult', data),
  mineruExtractText: (data) => call('mineru.extractText', data),
};
