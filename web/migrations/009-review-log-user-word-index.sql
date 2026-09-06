-- 009：review_log(user_id, word) 索引
-- /api/stats 的累计聚合 `SELECT COUNT(*), COUNT(DISTINCT word) FROM review_log
-- WHERE user_id = ?` 需要读 word 列，现有 (user_id, review_date)/(user_id, reviewed_at)
-- 索引都只覆盖到日期列，SQLite 只能按 user_id 收窄后回表扫该用户全部历史行
-- （重度用户一年可达数十万行）。(user_id, word) 让两条聚合都走 covering index。

CREATE INDEX IF NOT EXISTS idx_review_log_user_word ON review_log (user_id, word);
