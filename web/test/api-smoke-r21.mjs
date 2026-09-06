// 第二十一轮定向冒烟：
//   1) strField 类型门收口——wordbook.word / documents filename / sentences text / llm 入参
//      传对象不再被 String() 兜底成 "[object Object]" 入库（对象 word 直接 400，对象 filename 400，
//      对象句子被整行丢弃，llm/translate 对象 text 返回 400 缺 text）
//   2) migration 007：review_log(user_id, reviewed_at) 索引存在，r20 每日上限 COUNT 有索引支撑
//   3) 复习 / 统计 / 恢复路径回归
// 用法：先起 `npx wrangler dev --port 8788 --persist-to .tmp-r21-state`（全新库先灌 schema.sql），再 node 本脚本
import { DatabaseSync } from "node:sqlite";

const BASE = "http://127.0.0.1:8788";
const PERSIST = process.argv[2] || ".tmp-r21-state";
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
    return { status: resp.status, data };
  };
}

const suffix = Date.now().toString(36).slice(-5);

console.log("— 注册 —");
const member = jarClient();
let r = await member("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r21_member_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "注册成功");

console.log("— strField 收口：wordbook.word 传对象 → 400，不再存成 [object object] —");
r = await member("/api/wordbook", { method: "POST", body: JSON.stringify({ word: { evil: 1 } }) });
ok(r.status === 400, "word 传对象 → 400 缺少 word");
r = await member("/api/wordbook", { method: "POST", body: JSON.stringify({ word: "goodword21", phonetic: "/ɡʊd/" }) });
ok(r.status === 200 && r.data.id > 0, "正常 word 不受影响");
const wbId = r.data.id;
r = await member("/api/wordbook");
ok(!(r.data.words || []).some((w) => String(w.word).includes("object")), "生词本无 [object object] 垃圾行");

console.log("— strField 收口：restore 路径对象 word 行被丢弃 —");
r = await member("/api/wordbook/restore", {
  method: "POST",
  body: JSON.stringify({
    words: [
      { word: { o: 1 }, translation: "x" },
      { word: "restoreok21", translation: "正常" },
    ],
  }),
});
ok(r.status === 200 && r.data.restored === 1, "restore 传 2 行（1 个对象 word）→ restored=1");
r = await member("/api/wordbook");
ok((r.data.words || []).some((w) => w.word === "restoreok21"), "正常行恢复成功");

console.log("— strField 收口：documents filename 传对象 → 400 —");
r = await member("/api/documents", { method: "POST", body: JSON.stringify({ filename: { o: 1 }, exam_type: "IELTS" }) });
ok(r.status === 400 && String(r.data.error || "").includes("filename"), "filename 传对象 → 400 缺少 filename");
r = await member("/api/documents", { method: "POST", body: JSON.stringify({ filename: "doc21", exam_type: "IELTS" }) });
ok(r.status === 200 && r.data.id > 0, "正常 filename 建文档成功");
const docId = r.data.id;
r = await member(`/api/documents/${docId}`, { method: "PATCH", body: JSON.stringify({ filename: { o: 1 } }) });
ok(r.status === 400, "PATCH filename 传对象 → 400");
r = await member(`/api/documents/${docId}`, { method: "PATCH", body: JSON.stringify({ filename: "doc21-renamed" }) });
ok(r.status === 200, "PATCH 正常 filename 重命名成功");

console.log("— strField 收口：sentences text 传对象 → 整行丢弃（不计 position） —");
r = await member(`/api/documents/${docId}/sentences`, {
  method: "POST",
  body: JSON.stringify({
    sentences: [
      { text: { o: 1 }, tokens: [] },
      { text: "This is a normal sentence for r21.", tokens: ["this", "is", "normal", "sentence", "r21"] },
    ],
  }),
});
ok(r.status === 200 && r.data.inserted === 1 && r.data.start === 0, "对象句子被丢弃，仅正常句子入库（start=0 无空洞）");
r = await member(`/api/documents/${docId}/sentences`);
ok(r.data.total === 1 && !String(r.data.sentences?.[0]?.text || "").includes("object"), "文档内无 [object Object] 句子");

console.log("— strField 收口：llm/translate text 传对象 → 400 缺 text（未配置 Key 也先过参数门） —");
r = await member("/api/llm/translate", { method: "POST", body: JSON.stringify({ text: { o: 1 } }) });
ok(r.status === 400 && String(r.data.error || "").includes("text"), "text 传对象 → 400 缺少 text");

console.log("— migration 007：review_log(user_id, reviewed_at) 索引存在 —");
let db;
try {
  const fs = await import("node:fs");
  const path = (await import("node:path")).default;
  const d1dir = `${PERSIST}/v3/d1/miniflare-D1DatabaseObject`;
  const f = fs.readdirSync(d1dir).find((x) => x.endsWith(".sqlite") && x !== "metadata.sqlite");
  db = new DatabaseSync(path.join(d1dir, f), { readOnly: true });
} catch (e) {
  db = null;
  console.error(`  ! 无法打开本地 D1 文件（${e.message}），跳过索引检查`);
}
if (db) {
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_review_log_user_reviewed'").get();
  ok(!!idx, "idx_review_log_user_reviewed 已建立");
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM review_log WHERE user_id = 1 AND reviewed_at >= '2026-01-01 00:00:00'").all();
  const planText = plan.map((p) => p.detail || "").join(" | ");
  ok(/idx_review_log_user_reviewed/.test(planText), `每日上限 COUNT 查询命中新索引（plan: ${planText}）`);
  db.close();
}

console.log("— 复习 / 统计回归 —");
r = await member("/api/wordbook/review", {
  method: "POST",
    body: JSON.stringify({ id: wbId, familiarity: 3, graded_as: "know", next_review_at: "2026-09-08 12:00:00", review_date: "2026-09-06" }),
});
ok(r.status === 200, `复习评分正常（id=${wbId}）`);
r = await member("/api/stats");
ok(r.status === 200 && r.data.total_reviews >= 1, "统计正常返回");
r = await member("/api/search?word=run");
ok(r.status === 200, "搜索接口回归正常");

console.log(`\nr21 smoke: ${passed} 项通过${process.exitCode ? "（存在失败）" : ""}`);
