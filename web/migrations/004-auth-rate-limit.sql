-- 004 · 登录/注册限速：按来源 IP 记录认证请求（worker.js authRateLimit 消费）
-- 只记 ip + 时间，不记用户名/密码，不涉及任何业务数据。
CREATE TABLE IF NOT EXISTS auth_attempts (
    ip TEXT NOT NULL,
    attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_ip_time ON auth_attempts (ip, attempted_at);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_time ON auth_attempts (attempted_at);
