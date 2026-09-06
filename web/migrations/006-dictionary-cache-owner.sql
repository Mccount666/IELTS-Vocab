-- 006: 词典缓存所有者隔离。
-- /api/llm/define 会把用户自配 LLM 返回的释义写入 dictionary_cache，而该表按 word 全局唯一、
-- 所有用户共享：开放注册下任何用户可以把常用词的释义污染成任意内容，
-- 其他用户查词（/api/dictionary、/api/search）与中文反查都会读到被污染的缓存。
-- 引入 created_by 标记写入者：
--   NULL  = 可信共享条目（dictionaryapi.dev 在线词典，内容来自固定上游）
--   非NULL = 某用户的 LLM 生成条目，仅该用户自己可见
-- 读路径只放行「created_by IS NULL OR created_by = 当前用户」；
-- 写路径：可信写入总是覆盖，用户级写入只覆盖非共享行（不动公共可信条目）。
-- 存量行无法区分来源，统一视为可信共享（与改造前的实际暴露面一致）。

ALTER TABLE dictionary_cache ADD COLUMN created_by INTEGER;
