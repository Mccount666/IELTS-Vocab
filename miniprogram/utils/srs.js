const SRS_INTERVALS = [1, 2, 4, 8, 16, 32];

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDateTimeString(date = new Date()) {
  return `${localDateString(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function addDaysAtNoon(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(12, 0, 0, 0);
  return localDateTimeString(date);
}

function normalizeFamiliarity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(5, Math.round(n)));
}

function gradeReview(currentFamiliarity, grade) {
  const current = normalizeFamiliarity(currentFamiliarity);
  let next = current;
  let gradedAs = grade;
  if (grade === 'forgot') next = Math.max(0, current - 1);
  else if (grade === 'hard') next = current;
  else if (grade === 'know') next = Math.min(5, current + 1);
  else gradedAs = 'hard';

  const interval = gradedAs === 'know' ? SRS_INTERVALS[next] || 32 : 1;
  return {
    familiarity: next,
    gradedAs,
    reviewDate: localDateString(),
    reviewedAt: localDateTimeString(),
    nextReviewAt: addDaysAtNoon(interval),
  };
}

function isDueWord(entry, today = localDateString()) {
  const next = String(entry && entry.nextReviewAt ? entry.nextReviewAt : '');
  if (!next) return true;
  return next.slice(0, 10) <= today;
}

module.exports = {
  SRS_INTERVALS,
  localDateString,
  localDateTimeString,
  gradeReview,
  isDueWord,
  normalizeFamiliarity,
};
