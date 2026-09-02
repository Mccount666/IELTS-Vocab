-- 迁移 003 · SRS 到期调度 + 学习统计（2026-09-02）
-- 1) wordbook.next_review_at：下次应复习的本地时间（YYYY-MM-DD HH:MM:SS，客户端时区）；
--    '' 表示从未调度 = 立即到期（新词与历史存量词都视为待复习）。
-- 2) review_log：每次复习评分一条，驱动统计页与连续打卡。
--    review_date 存客户端本地日期（跨时区用户各自准确），reviewed_at 存服务端 UTC 时间。
-- 纯增量（ADD COLUMN + 新表），对已有多用户数据安全；重复执行会报 duplicate column，忽略即可。

ALTER TABLE wordbook ADD COLUMN next_review_at TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS review_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    wordbook_id INTEGER,
    word TEXT NOT NULL DEFAULT '',
    graded_as TEXT NOT NULL DEFAULT '',
    familiarity INTEGER NOT NULL DEFAULT 0,
    review_date TEXT NOT NULL,
    reviewed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_log_user_date ON review_log(user_id, review_date);
