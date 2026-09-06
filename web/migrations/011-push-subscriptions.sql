-- 011：Web Push 推送订阅（每日复习提醒）
-- 每台浏览器设备一条订阅：endpoint 全局唯一（同一浏览器换账号重新订阅会覆盖
-- user_id），p256dh/auth 是推送服务的加密公钥与鉴权密钥（本实现推送不带 payload，
-- 字段照常保存以便日后升级到带载荷推送）。cron 每天给有到期词的用户发空推送，
-- Service Worker 收到后自行拉取到期数再弹通知；推送服务返回 404/410 时删除订阅。

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);
