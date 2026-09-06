-- 008：登录按用户名维度的失败锁定
-- 004 的 auth_attempts 只按 IP 限速，同一 IP 30 次/15 分钟的窗口内可以对某个账号
-- 做几十次定向密码猜测（分布式 IP 更是完全不受限）。auth_failures 按「用户名 + 时间」
-- 记登录失败，同一用户名窗口内失败达上限后登录直接 429（成功登录即清零，
-- 正常用户输错几次密码不会被永久锁死）。

CREATE TABLE IF NOT EXISTS auth_failures (
    username TEXT NOT NULL,
    ip TEXT NOT NULL,
    attempted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_failures_user_time ON auth_failures (username, attempted_at);
CREATE INDEX IF NOT EXISTS idx_auth_failures_time ON auth_failures (attempted_at);
