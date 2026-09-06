-- 007: review_log 增加 (user_id, reviewed_at) 索引。
-- 第二十轮加的复习每日上限按服务端 reviewed_at（UTC 自然日）COUNT：
--   SELECT COUNT(*) FROM review_log WHERE user_id = ? AND reviewed_at >= ?
-- 之前只有 (user_id, review_date) 索引，SQLite 只能按 user_id 收窄后再全量过滤该用户的
-- 全部历史行；重度用户一年可达数十万行，每次评分都变慢。本索引让该查询只扫当日的行。
CREATE INDEX IF NOT EXISTS idx_review_log_user_reviewed ON review_log (user_id, reviewed_at);
