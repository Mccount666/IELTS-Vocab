// ECDICT sqlite → 公共词库 JSONL（微信云开发控制台可直接导入的 JSON Lines）
// 用法：
//   node miniprogram/scripts/build-ecdict-subset.mjs <ecdict.db> <输出目录>
// 筛选策略：带考试标签（cet4/cet6/ielts/toefl/gre/kaoyan/oxford）或高频词（frq/bnc 靠前），
// 上限 5 万词，输出按 5000 条一个 JSONL 分批，字段对齐 public_dictionary。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [dbPath, outDir] = process.argv.slice(2);
if (!dbPath || !outDir) {
  console.error('用法：node miniprogram/scripts/build-ecdict-subset.mjs <ecdict.db> <输出目录>');
  process.exit(1);
}

const BATCH = 5000;
const LIMIT = 50000;
// ECDICT tag 体系：zk=中考 gk=高考 cet4/cet6 ky=考研 ielts toefl gre（无 tem/bec）
const TAGS_WANT = ['zk', 'gk', 'cet4', 'cet6', 'ky', 'ielts', 'toefl', 'gre'];
const FREQ_MAX = 20000; // frq/bnc 任一排名 <= 该值视为常用词

const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
const table = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((r) => r.name)[0];
console.log('table:', table);
const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
console.log('cols:', cols.join(','));

const rows = db
  .prepare(`SELECT word, phonetic, definition, translation, tag, bnc, frq, exchange, oxford FROM ${table}`)
  .all();
console.log('total rows:', rows.length);

const WORD_RE = /^[a-zA-Z][a-zA-Z'-]*$/;
const byWord = new Map();

for (const r of rows) {
  const raw = String(r.word || '').trim();
  if (!raw || !WORD_RE.test(raw)) continue;
  const word = raw.toLowerCase();
  const tags = String(r.tag || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const examTags = tags.filter((t) => TAGS_WANT.some((w) => t.startsWith(w)));
  const frq = Number(r.frq) || 0;
  const bnc = Number(r.bnc) || 0;
  const freqRank = Math.min(frq || Infinity, bnc || Infinity);
  const tagged = examTags.length > 0 || Number(r.oxford) === 1;
  if (!tagged && freqRank > FREQ_MAX) continue;

  const translation = String(r.translation || '').replace(/\r?\n/g, '； ').trim();
  if (!translation) continue;
  const definition = String(r.definition || '').replace(/\r?\n/g, ' ').trim();

  const cand = {
    word,
    phonetic: r.phonetic ? `/${String(r.phonetic).trim()}/` : '',
    translation,
    definition,
    tags: [...new Set(examTags)].join(' '),
    frq: freqRank === Infinity ? 0 : freqRank,
  };
  const prev = byWord.get(word);
  if (!prev) {
    byWord.set(word, cand);
  } else {
    // 合并：释义取非空更长者，标签取并集，frq 取更小
    if (cand.translation.length > prev.translation.length) {
      prev.translation = cand.translation;
      prev.definition = cand.definition || prev.definition;
      prev.phonetic = cand.phonetic || prev.phonetic;
    }
    prev.tags = [...new Set([...prev.tags.split(' '), ...cand.tags.split(' ')].filter(Boolean))].join(' ');
    prev.frq = Math.min(prev.frq, cand.frq);
  }
}

const all = [...byWord.values()];
// 排序：带考试标签的优先，其次词频
all.sort((a, b) => (b.tags ? 1 : 0) - (a.tags ? 1 : 0) || a.frq - b.frq || a.word.localeCompare(b.word));
const selected = all.slice(0, LIMIT);
console.log('unique words:', all.length, '→ selected:', selected.length);

mkdirSync(outDir, { recursive: true });
for (let i = 0, batch = 0; i < selected.length; i += BATCH, batch++) {
  const lines = selected.slice(i, i + BATCH).map((w) =>
    JSON.stringify({
      word: w.word,
      phonetic: w.phonetic,
      translation: w.translation,
      definition: w.definition,
      examples: [],
      source: 'ECDICT',
      tags: w.tags,
      addedAt: 'ecdict-1.0.28',
    })
  );
  const file = join(outDir, `public-dict-${String(batch + 1).padStart(2, '0')}.jsonl`);
  writeFileSync(file, lines.join('\n'), 'utf8');
  console.log(file, `${lines.length} 条`);
}

const taggedCount = selected.filter((w) => w.tags).length;
console.log(`统计：共 ${selected.length} 条，带考试标签 ${taggedCount} 条`);
