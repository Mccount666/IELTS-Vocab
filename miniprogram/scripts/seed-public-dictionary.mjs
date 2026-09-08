// 公共词库导入脚本（安全校验版）
// 用法：
//   node miniprogram/scripts/seed-public-dictionary.mjs <词库.json>
//
// 词库文件格式（JSON 数组，每条一个词条）：
// [
//   {
//     "word": "environment",
//     "lemma": "environment",
//     "phonetic": "/ɪnˈvaɪrənmənt/",
//     "translation": "n. 环境；自然环境",
//     "definition": "The surroundings or conditions in which a person, animal, or plant lives or operates.",
//     "examples": [{ "en": "The environment is under increasing pressure.", "zh": "环境正承受越来越大的压力。" }],
//     "source": "公共词库"
//   }
// ]
//
// 校验通过后，请到微信开发者工具 → 云开发控制台 → 数据库 → public_dictionary
// 集合 → 「导入」按钮，选择本 JSON 文件（也可先改名，支持 JSON/CSV），
// 冲突处理选 insert。导入后查词页会优先命中公共词库。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORD_RE = /^[a-zA-Z]+(?:'[a-z]+)?(?:-[a-zA-Z]+)*$/;

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}

const file = process.argv[2];
if (!file) {
  console.error('用法：node miniprogram/scripts/seed-public-dictionary.mjs <词库.json>');
  console.error(`示例文件：${resolve(__dirname, 'public-dictionary.sample.json')}`);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(resolve(file), 'utf8');
} catch (e) {
  fail(`读取文件失败：${e.message}`);
  process.exit(1);
}

let rows;
try {
  rows = JSON.parse(raw);
} catch (e) {
  fail(`不是合法 JSON：${e.message}`);
  process.exit(1);
}

if (!Array.isArray(rows)) {
  fail('词库文件必须是 JSON 数组（[] 包裹）');
  process.exit(1);
}

const seen = new Set();
let valid = 0;
const problems = [];

rows.forEach((row, idx) => {
  const tag = `第 ${idx + 1} 条`;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    problems.push(`${tag}：不是对象`);
    return;
  }
  const word = typeof row.word === 'string' ? row.word.trim().toLowerCase() : '';
  if (!word || !WORD_RE.test(word)) {
    problems.push(`${tag}：word 缺失或含非法字符（"${String(row.word).slice(0, 40)}"）`);
    return;
  }
  if (seen.has(word)) {
    problems.push(`${tag}：word 重复（"${word}"）`);
    return;
  }
  seen.add(word);
  const translation = typeof row.translation === 'string' ? row.translation.trim() : '';
  if (!translation) {
    problems.push(`${tag}（"${word}"）：缺中文释义 translation`);
    return;
  }
  const examples = Array.isArray(row.examples) ? row.examples : [];
  for (const ex of examples) {
    if (!ex || typeof ex.en !== 'string' || !ex.en.trim()) {
      problems.push(`${tag}（"${word}"）：存在缺 en 的例句`);
      return;
    }
  }
  valid += 1;
});

console.log(`共 ${rows.length} 条，有效 ${valid} 条`);
if (problems.length) {
  problems.slice(0, 20).forEach((p) => fail(p));
  if (problems.length > 20) console.error(`…以及另外 ${problems.length - 20} 个问题`);
  process.exit(1);
}

console.log('✓ 校验通过');
console.log('');
console.log('导入步骤：');
console.log('1. 打开微信开发者工具 → 云开发 → 数据库 → public_dictionary 集合');
console.log('   （若集合不存在，先随便触发一次云函数，ensureCollections 会自动建）');
console.log('2. 点「导入」，选择本 JSON 文件，冲突处理选 insert');
console.log('3. 导入完成后到「查词」页验证：公共词库词条会带「公共词库」来源徽标');
