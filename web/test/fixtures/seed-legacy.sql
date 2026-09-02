-- 测试夹具：模拟多用户改造前线上的旧数据（无任何用户概念）
-- documents/sentences/words/word_sentences/wordbook 全部无归属；
-- settings 里已配过 LLM Key（迁移后应进 legacy 槽 user_id = -1，由首个注册账号认领）。

INSERT INTO documents (filename, exam_type, imported_at) VALUES ('cambridge18-test1.pdf', 'IELTS', '2026-09-01 10:00:00');

INSERT INTO sentences (document_id, text, position) VALUES
  (1, 'The government has abandoned its plan to build a new airport.', 0),
  (1, 'Many critics argue that the decision was deliberately delayed.', 1);

INSERT INTO words (word, lemma) VALUES ('abandoned', 'abandon'), ('deliberately', 'deliberately');

INSERT INTO word_sentences (word_id, sentence_id) VALUES (1, 1), (2, 2);

INSERT INTO wordbook (word, phonetic, translation, definition, sentence_id, added_at)
VALUES ('abandoned', '/əˈbændənd/', '被放弃的', 'left without intended occupants or users', 1, '2026-09-01 11:00:00');

INSERT INTO settings (key, value) VALUES
  ('llm_base_url', 'https://api.deepseek.com/v1'),
  ('llm_model', 'deepseek-chat'),
  ('llm_api_key', 'sk-legacy-test-key-123456'),
  ('access_code', 'old-code');
