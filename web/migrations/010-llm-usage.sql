-- 010：LLM 代理每用户每日调用计数
-- /api/llm/define 与 /api/llm/translate 走用户自配的 Key，但每次调用都消耗
-- 全站共享的 Cloudflare 免费请求额度；开放注册下脚本滥用一个账号就能烧掉
-- 所有人当天的额度。(user_id, day) 计数行由 INSERT..ON CONFLICT..RETURNING
-- 原子自增，达上限后当日直接 429。

CREATE TABLE IF NOT EXISTS llm_usage (
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
