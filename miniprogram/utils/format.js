function toast(title, icon = 'none') {
  wx.showToast({ title, icon, duration: 1800 });
}

function loading(title = '处理中') {
  wx.showLoading({ title, mask: true });
}

function hideLoading() {
  wx.hideLoading();
}

function examTypeLabel(value) {
  const map = { IELTS: 'IELTS', TOEFL: 'TOEFL', GRE: 'GRE', Other: '其他' };
  return map[value] || value || '其他';
}

function familiarityLabel(value) {
  const n = Number(value) || 0;
  if (n <= 2) return '生疏';
  if (n <= 4) return '一般';
  return '熟练';
}

function shortDate(value) {
  if (!value) return '今日';
  return String(value).slice(5, 10);
}

module.exports = {
  toast,
  loading,
  hideLoading,
  examTypeLabel,
  familiarityLabel,
  shortDate,
};
