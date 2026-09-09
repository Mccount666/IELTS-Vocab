// ECDICT exchange → word_forms 不规则词形表（供查词扩展命中不同时态/形式）
// 只保留「规则变形推导不出来」的词形关系（ran→run、went→go、better→good 等），
// 规则变形（walks/walked/walking）由云函数端 ruleExpand 现场生成，表保持在几 KB~几 MB。
// 用法：node miniprogram/scripts/build-word-forms.mjs <stardict.db> <seed函数目录>
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [dbPath, outDir] = process.argv.slice(2);
if (!dbPath || !outDir) {
  console.error('用法：node miniprogram/scripts/build-word-forms.mjs <stardict.db> <seed目录>');
  process.exit(1);
}

const WORD_RE = /^[a-z]+(?:'[a-z]+)?(?:-[a-z]+)*$/;
const BATCH = 5000;

// 与云函数 api/index.js ruleExpand 保持一致（Set 版，供覆盖性检查）
function ruleExpand(word) {
  const out = new Set([word]);
  out.add(`${word}s`);
  out.add(`${word}es`);
  if (word.endsWith('y') && word.length > 2) out.add(`${word.slice(0, -1)}ies`);
  if (word.endsWith('e')) {
    out.add(`${word}d`);
    out.add(`${word.slice(0, -1)}ing`);
  } else {
    out.add(`${word}ed`);
    out.add(`${word}ing`);
    const prev = word.slice(-2, -1);
    const last = word.slice(-1);
    if (word.length >= 3 && !/[aeiouwxy]$/.test(prev) && !/[aeiouwxy]$/.test(last)) {
      out.add(`${word}${last}ed`);
      out.add(`${word}${last}ing`);
    }
  }
  return out;
}

// 与云函数 api/index.js lemmatize 保持一致
function lemmatize(word) {
  word = String(word || '').toLowerCase();
  if (word.endsWith("'s")) word = word.slice(0, -2);
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.length > 5 ? word.slice(0, -2) : word;
  return word;
}

const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
const rows = db.prepare(`SELECT word, exchange FROM stardict WHERE exchange IS NOT NULL AND exchange <> ''`).all();
console.log('rows with exchange:', rows.length);

// F = 同一词条的全部形态（word + exchange 各键值 + lemma0）
// formsMap[f] ∪= F：查任何形态 f 都能拿到整组
const formsMap = new Map();
for (const r of rows) {
  const w = String(r.word || '').toLowerCase().trim();
  if (!w || !WORD_RE.test(w)) continue;
  const F = new Set([w]);
  // 只取词形键：0=原形 3=三单 d=过去分词 i=现在分词 p=过去式 r/t=比较级最高级 s=复数
  // 键 1 是变形类别元数据（值如 p/dp/i，不是单词），必须排除
  const KEEP = new Set(['0', 'd', 'i', 'p', '3', 'r', 't', 's']);
  for (const pair of String(r.exchange).split(/[/!]/)) {
    const idx = pair.indexOf(':');
    if (idx < 1) continue;
    const key = pair.slice(0, idx);
    if (!KEEP.has(key)) continue;
    const v = pair.slice(idx + 1).toLowerCase().trim();
    if (v && WORD_RE.test(v) && v.length <= 40) F.add(v);
  }
  if (F.size < 2) continue;
  for (const f of F) {
    const prev = formsMap.get(f);
    if (prev) for (const x of F) prev.add(x);
    else formsMap.set(f, new Set(F));
  }
}

const out = [];
for (const [word, F] of formsMap) {
  const forms = Array.from(F).sort();
  if (forms.length < 2 || word.length < 2) continue;
  // 覆盖性检查：本词及其规则原形的规则变形能拿到全部同组形态 → 不需要表行，
  // 查询端 ruleExpand(lemmatize(w)) 现场生成；只有不规则的（ran→run）才入库
  const covered = new Set([...ruleExpand(word), ...ruleExpand(lemmatize(word))]);
  if (Array.from(F).every((f) => f === word || covered.has(f))) continue;
  out.push({ word, forms: forms.slice(0, 12) });
}
out.sort((a, b) => a.word.localeCompare(b.word));
console.log('irregular rows:', out.length);

mkdirSync(outDir, { recursive: true });
let total = 0;
for (let i = 0, batch = 0; i < out.length; i += BATCH, batch++) {
  const slice = out.slice(i, i + BATCH);
  writeFileSync(join(outDir, `word-forms-${String(batch + 1).padStart(2, '0')}.jsonl`), slice.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
  total += slice.length;
}
console.log('written', total, 'rows in', Math.ceil(out.length / BATCH), 'files');
