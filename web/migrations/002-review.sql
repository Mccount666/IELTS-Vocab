-- 迁移 002 · 生词本复习功能（2026-09-02）
-- 为 wordbook 增加轻量 SRS 字段：熟悉度 0-5 与最近复习时间。
-- 纯增量（ALTER TABLE ADD COLUMN），对已有多用户数据安全，可重复执行前请先确认未跑过。

ALTER TABLE wordbook ADD COLUMN familiarity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wordbook ADD COLUMN last_reviewed_at TEXT NOT NULL DEFAULT '';
