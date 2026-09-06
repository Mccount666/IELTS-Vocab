-- 真题词库 Web 版 · D1 数据库结构（多用户版）
-- 前四张表与桌面版 SQLite 结构一致（可互迁），其余为 Web 版新增/改造。
-- 已部署的旧库请用 migrations/001-multiuser.sql 增量迁移，不要直接重跑本文件。

-- 用户表：首个注册的账号自动成为站长（is_admin = 1）
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

-- 会话表：只存 token 的 SHA-256，明文 token 只在 cookie 里
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

-- 文档表：每份导入的真题来源，user_id = 0 表示多用户改造前的历史数据
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 0,
    filename TEXT NOT NULL,
    exam_type TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    -- 句子位置计数器：appendSentences 用 UPDATE ... RETURNING 原子预分配 position 区间（005）
    next_pos INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);

-- 句子表：拆分后的句子（归属随 documents.user_id）
CREATE TABLE IF NOT EXISTS sentences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    position INTEGER NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id)
);

-- 词表：word 唯一，存原始形与词干形（全局共享的公共词形数据）
CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,
    lemma TEXT,
    UNIQUE(word)
);

-- 倒排索引：词 → 句子 多对多
CREATE TABLE IF NOT EXISTS word_sentences (
    word_id INTEGER NOT NULL,
    sentence_id INTEGER NOT NULL,
    PRIMARY KEY (word_id, sentence_id),
    FOREIGN KEY (word_id) REFERENCES words(id),
    FOREIGN KEY (sentence_id) REFERENCES sentences(id)
);

CREATE INDEX IF NOT EXISTS idx_word_sentences_word ON word_sentences(word_id);
CREATE INDEX IF NOT EXISTS idx_word_sentences_sentence ON word_sentences(sentence_id);
CREATE INDEX IF NOT EXISTS idx_words_lemma ON words(lemma);
CREATE INDEX IF NOT EXISTS idx_sentences_document ON sentences(document_id);

-- 生词本：按用户隔离，同一词可被不同用户各自收藏。
-- familiarity（0-5，复习模式评分）与 last_reviewed_at 由 002-review.sql 引入；
-- next_review_at（下次应复习的本地时间，'' = 立即到期）由 003-srs.sql 引入。
CREATE TABLE IF NOT EXISTS wordbook (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 0,
    word TEXT NOT NULL,
    phonetic TEXT NOT NULL DEFAULT '',
    translation TEXT NOT NULL DEFAULT '',
    definition TEXT NOT NULL DEFAULT '',
    sentence_id INTEGER,
    added_at TEXT NOT NULL,
    familiarity INTEGER NOT NULL DEFAULT 0,
    last_reviewed_at TEXT NOT NULL DEFAULT '',
    next_review_at TEXT NOT NULL DEFAULT '',
    UNIQUE(user_id, word)
);
CREATE INDEX IF NOT EXISTS idx_wordbook_user ON wordbook(user_id);

-- 复习日志：每次评分一条，驱动统计页与连续打卡（003-srs.sql）
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

-- 词典缓存：dictionaryapi.dev 在线释义全局共享；各用户 LLM 生成的释义按用户隔离
--（created_by 006 引入，NULL = 可信共享条目），命中缓存不再消耗任何人的 Key 额度
CREATE TABLE IF NOT EXISTS dictionary_cache (
    word TEXT PRIMARY KEY,
    phonetic TEXT NOT NULL DEFAULT '',
    translation TEXT NOT NULL DEFAULT '',
    definition TEXT NOT NULL DEFAULT '',
    examples TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    created_by INTEGER
);

-- 每用户运行时设置（LLM / MinerU API Key 等，键值对；Key 明文永不下发浏览器）
-- user_id = -1 是迁移槽：改造前配置在旧 settings 表里的 Key 会复制到这里，
-- 由第一个注册的账号（站长）认领。
CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, key)
);

-- 站点级设置（站长专用，如注册码 registration_code）
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

-- 登录/注册限速：按来源 IP 记录认证请求（004-auth-rate-limit.sql）
CREATE TABLE IF NOT EXISTS auth_attempts (
    ip TEXT NOT NULL,
    attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_ip_time ON auth_attempts (ip, attempted_at);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_time ON auth_attempts (attempted_at);
