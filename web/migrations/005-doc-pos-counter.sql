-- 005: 文档句子位置计数器。
-- appendSentences 改用 UPDATE ... RETURNING 原子预分配 position 区间，
-- 消除并发追加同一文档时 MAX(position)+1 先读后写产生重复 position 的竞态
-- （重复 position 会打乱上下文浏览顺序、错位备份恢复的句子 id 映射）。
-- next_pos = 该文档下一个可用的 position；存量文档按现有句子回填。

ALTER TABLE documents ADD COLUMN next_pos INTEGER NOT NULL DEFAULT 0;

UPDATE documents
SET next_pos = (SELECT COALESCE(MAX(position), -1) + 1 FROM sentences WHERE document_id = documents.id)
WHERE next_pos = 0;
