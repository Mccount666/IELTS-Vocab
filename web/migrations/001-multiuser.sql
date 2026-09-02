-- 001 · 多用户改造迁移（2026-09-02）
-- 适用于已按旧 schema.sql 部署的库；全新部署直接跑 schema.sql，不要跑本文件。
-- D1 文件导入是原子的：任一步失败整体回滚，可安全重试。

-- 1) 新表：用户 / 会话 / 每用户设置
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, key)
);

-- 2) documents 加 user_id（0 = 改造前的历史数据，待站长认领）
ALTER TABLE documents ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);

-- 3) wordbook 重建：UNIQUE(word) → UNIQUE(user_id, word)
CREATE TABLE wordbook_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 0,
    word TEXT NOT NULL,
    phonetic TEXT NOT NULL DEFAULT '',
    translation TEXT NOT NULL DEFAULT '',
    definition TEXT NOT NULL DEFAULT '',
    sentence_id INTEGER,
    added_at TEXT NOT NULL,
    UNIQUE(user_id, word)
);
INSERT INTO wordbook_new (id, user_id, word, phonetic, translation, definition, sentence_id, added_at)
    SELECT id, 0, word, phonetic, translation, definition, sentence_id, added_at FROM wordbook;
DROP TABLE wordbook;
ALTER TABLE wordbook_new RENAME TO wordbook;
CREATE INDEX IF NOT EXISTS idx_wordbook_user ON wordbook(user_id);

-- 4) 旧 settings 表里的 API Key 复制到 legacy 槽（user_id = -1），由首个注册账号认领；
--    settings 表本身保留，转作站点级设置（注册码）。access_code 随账号体系废弃。
INSERT OR IGNORE INTO user_settings (user_id, key, value)
    SELECT -1, key, value FROM settings
    WHERE key IN ('llm_base_url', 'llm_model', 'llm_api_key', 'mineru_api_token')
      AND value != '';
