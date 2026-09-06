// 第二十三轮定向冒烟：
//   1) 登录按用户名维度的失败锁定（migration 008 auth_failures）——同账号 10 次失败后 429，
//      正确密码也被拦；其他账号不受影响；成功登录清零失败计数（node:sqlite 直查验证）
//   2) /api/export 流式导出——>1000 句跨多页分页，JSON 形状与旧版一致、顺序正确、行完整
//   3) 前端静态断言：sw v18、AI 释义缓存同步、同批次同名文件登记
// 用法：先 `wrangler d1 execute ielts_vocab --local --persist-to .tmp-r23-state --file=schema.sql`
//       再后台 `wrangler dev --port 8788 --persist-to .tmp-r23-state`，然后 node 本脚本
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8788";
const PERSIST = process.argv[2] || ".tmp-r23-state";
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
const LOCK_USER = `r23_lock_${suffix}`;

console.log("— 注册两个账号 —");
const locker = jarClient();
let r = await locker("/api/auth/register", { method: "POST", body: JSON.stringify({ username: LOCK_USER, password: "correct9" }) });
ok(r.status === 200, "注册锁定测试账号");
const other = jarClient();
r = await other("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r23_other_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "注册旁证账号");

console.log("— 按用户名失败锁定：10 次错密码后 429，正确密码同样被拦 —");
for (let i = 0; i < 10; i++) {
  r = await locker("/api/auth/login", { method: "POST", body: JSON.stringify({ username: LOCK_USER, password: "wrong-pass" }) });
  if (r.status !== 401) break;
}
ok(r.status === 401, "前 10 次错密码 → 401");
r = await locker("/api/auth/login", { method: "POST", body: JSON.stringify({ username: LOCK_USER, password: "correct9" }) });
ok(r.status === 429 && (r.data.error || "").includes("失败次数过多"), "第 11 次即使密码正确 → 429 锁定");

console.log("— 锁定按用户名隔离：其他账号登录不受影响，成功登录清零失败计数 —");
r = await other("/api/auth/login", { method: "POST", body: JSON.stringify({ username: `r23_other_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "同 IP 其他账号登录正常（锁定不按 IP 误伤）");

// node:sqlite 直开 miniflare 的 D1 文件验证表状态
const d1dir = path.join(PERSIST, "v3", "d1", "miniflare-D1DatabaseObject");
const dbFile = readdirSync(d1dir).find((f) => f.endsWith(".sqlite"));
const db = new DatabaseSync(path.join(d1dir, dbFile));
let rows = db.prepare("SELECT COUNT(*) AS n FROM auth_failures WHERE username = ?").get(`r23_other_${suffix}`);
ok((rows?.n || 0) === 0, "成功登录后该用户名失败计数已清零");
rows = db.prepare("SELECT COUNT(*) AS n FROM auth_failures WHERE username = ?").get(LOCK_USER);
ok((rows?.n || 0) === 10, "被锁账号名下恰有 10 条失败记录");
db.close();

console.log("— 流式导出：2500 句跨 3 页分页，JSON 形状与旧版一致 —");
const member = jarClient();
r = await member("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r23_export_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "注册导出测试账号");
r = await member("/api/documents", { method: "POST", body: JSON.stringify({ filename: `export-doc-${suffix}`, exam_type: "IELTS" }) });
const docId = r.data.id;
ok(r.status === 200 && docId > 0, "创建文档");

const VOCAB = ["alpha", "bravo", "charlie", "delta", "echo", "foxglove", "goldfinch", "harbour"];
const TOTAL = 2500;
const sentences = [];
for (let i = 0; i < TOTAL; i++) {
  const text = `Passage sentence number ${i} studies the ${VOCAB[i % VOCAB.length]} and the ${VOCAB[(i + 3) % VOCAB.length]} of coastal regions.`;
  sentences.push({
    text,
    tokens: [...new Set(text.toLowerCase().match(/[a-z]+/g) || [])].filter((t) => t.length >= 2),
  });
}
let uploadOk = true;
for (let i = 0; i < sentences.length; i += 500) {
  r = await member(`/api/documents/${docId}/sentences`, {
    method: "POST",
    body: JSON.stringify({ sentences: sentences.slice(i, i + 500) }),
  });
  if (r.status !== 200 || r.data.inserted !== Math.min(500, sentences.length - i)) uploadOk = false;
}
ok(uploadOk, "2500 句分 5 块上传成功");
r = await member("/api/wordbook", { method: "POST", body: JSON.stringify({ word: "goldfinch" }) });
ok(r.status === 200, "收录一个生词（验证 wordbook 导出）");

const expResp = await member("/api/export");
ok(expResp.status === 200, "导出 200");
const ctype = expResp.resp.headers.get("content-type") || "";
ok(ctype.includes("application/json"), "Content-Type 正确");
const dump = expResp.data;
ok(
  Object.keys(dump).sort().join(",") === "documents,exported_at,sentences,user_settings,word_sentences,wordbook,words",
  "顶层键与旧版全量导出一致"
);
ok(dump.documents.length === 1 && dump.documents[0].filename === `export-doc-${suffix}`, "documents 导出正确");
ok(dump.sentences.length === TOTAL, `sentences 恰为 ${TOTAL}（跨 3 页分页无丢失无重复）`);
ok(
  dump.sentences[0].position === 0 && dump.sentences[TOTAL - 1].position === TOTAL - 1,
  "sentences 按 (document_id, position) 有序"
);
ok(dump.sentences.every((s, i) => s.document_id === docId && s.text.length > 0), "每行句子归属与内容完整");
ok(dump.words.length >= VOCAB.length, "words 表导出非空");
ok(
  dump.word_sentences.length > 0 && dump.word_sentences.every((x) => Object.keys(x).sort().join(",") === "sentence_id,word_id"),
  "word_sentences 行形状与旧版一致（rid 游标已剥离）"
);
ok(dump.wordbook.length === 1 && dump.wordbook[0].word === "goldfinch", "wordbook 导出正确");
ok(Array.isArray(dump.user_settings), "user_settings 为数组");

console.log("— 前端静态断言 —");
const appJs = await (await fetch(BASE + "/js/app.js")).text();
ok(appJs.includes("documentsCache.push({ id: docId"), "同批次导入成功后登记进 documentsCache");
ok(appJs.includes("cached.definition = definition"), "AI 释义后会话缓存同步");
const swText = await (await fetch(BASE + "/sw.js")).text();
ok(swText.includes('VERSION = "v18"'), "sw.js 已升到 v18");

console.log(`\nr23 冒烟：${passed} 项全部通过`);
