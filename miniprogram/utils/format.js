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
  const map = {
    IELTS: '雅思 IELTS',
    TOEFL: '托福 TOEFL',
    GRE: 'GRE',
    GMAT: 'GMAT',
    SAT: 'SAT',
    ACT: 'ACT',
    AP: 'AP',
    'A-Level': 'A-Level',
    IB: 'IB',
    Gaokao: '高考',
    Zhongkao: '中考',
    'CET-4': '大学英语四级 CET-4',
    'CET-6': '大学英语六级 CET-6',
    Kaoyan: '考研英语',
    'TEM-4': '专四 TEM-4',
    'TEM-8': '专八 TEM-8',
    BEC: '商务英语 BEC',
    TOEIC: '托业 TOEIC',
    PTE: 'PTE',
    Duolingo: 'Duolingo English Test',
    LSAT: 'LSAT',
    MCAT: 'MCAT',
    Other: '其他',
  };
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
