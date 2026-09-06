// 第二十四轮定向冒烟：
//   1) migration 009：review_log(user_id, word) 索引存在，stats 累计聚合
//      COUNT(DISTINCT word) 命中 covering index（原按 user_id 回表扫全部历史行）
//   2) 中文反查回归（searchByChinese 加 LIMIT 兜底后行为不变）
//   3) Electron 壳导航守卫已改 origin 精确比较（startsWith 前缀匹配可被仿冒域绕过）
// 用法：先 `wrangler d1 execute ielts_vocab --local --persist-to .tmp-r24-state --file=schema.sql`
//       再后台 `wrangler dev --port 8788 --persist-to .tmp-r24-state`，然后 node 本脚本
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8788";
const PERSIST = process.argv[2] || ".tmp-r24-state";
let passed = 0;
function ok(cond, name) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}`);
    process.exitCode = 1;
  }
}

function jarClient() {
  let cookie = "";
  return async (path, opts = {}) => {
    const resp = await fetch(BASE + path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
    });
    const setCookie = resp.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = await resp.json().catch(() => ({}));
    return { status: resp.status, data, resp };
  };
}

const suffix = Date.now().toString(36).slice(-5);

console.log("— migration 009：stats 聚合命中 covering index —");
const d1dir = path.join(PERSIST, "v3", "d1", "miniflare-D1DatabaseObject");
const dbFile = readdirSync(d1dir).find((f) => f.endsWith(".sqlite"));
const db = new DatabaseSync(path.join(d1dir, dbFile));
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_review_log_user_word'").get();
ok(Boolean(idx), "idx_review_log_user_word 已建立");
const plan = db
  .prepare(
    "EXPLAIN QUERY PLAN SELECT COUNT(*) AS total_reviews, COUNT(DISTINCT word) AS distinct_words FROM review_log WHERE user_id = 1"
  )
  .all();
ok(
  plan.some((p) => String(p.detail).includes("COVERING INDEX idx_review_log_user_word")),
  `stats 聚合走 covering index（${plan[0]?.detail || "no plan"}）`
);
db.close();

console.log("— 中文反查回归（LIMIT 兜底不破坏正常路径） —");
const member = jarClient();
let r = await member("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r24_member_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "注册成功");
r = await member("/api/documents", { method: "POST", body: JSON.stringify({ filename: `r24-doc-${suffix}`, exam_type: "IELTS" }) });
const docId = r.data.id;
const sents = Array.from({ length: 5 }, (_, i) => ({
  text: `The crew decided to abandon the sinking vessel in record ${i}.`,
  tokens: [...new Set("the crew decided to abandon sinking vessel in record".split(" "))],
}));
r = await member(`/api/documents/${docId}/sentences`, { method: "POST", body: JSON.stringify({ sentences: sents }) });
ok(r.status === 200 && r.data.inserted === 5, "导入 5 句");
// 中文反查吃的是 dictionary_cache（本沙箱 dictionaryapi.dev 不通，直接种一条可信共享条目）
const d1 = new DatabaseSync(path.join(d1dir, dbFile));
d1
  .prepare(
    "INSERT INTO dictionary_cache (word, phonetic, translation, definition, examples, source, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
  .run("abandon", "/əˈbændən/", "放弃；抛弃", "to leave completely and finally", "[]", "test", new Date().toISOString().slice(0, 19).replace("T", " "), null);
d1.close();
r = await member(`/api/search?word=${encodeURIComponent("放弃")}`);
ok(r.status === 200 && (r.data.reverse?.words || []).some((w) => w.word === "abandon"), "中文反查命中候选词 abandon");
ok((r.data.sentences || []).length === 5 && r.data.sentences.every((s) => s.matched_word === "abandon"), "反查例句 5 条且 matched_word 正确");
r = await member("/api/search?word=abandon");
ok((r.data.sentences || []).length === 5, "英文正查回归正常");

console.log("— Electron 导航守卫 —");
const mainJs = readFileSync(new URL("../desktop/main.js", import.meta.url), "utf8");
ok(mainJs.includes("new URL(SITE_URL).origin"), "导航守卫按 origin 精确比较");
ok(!mainJs.includes("startsWith(SITE_URL)"), "startsWith 前缀匹配已移除");

console.log(`\nr24 冒烟：${passed} 项全部通过`);
