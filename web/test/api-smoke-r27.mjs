// 第二十七轮定向冒烟：
//   1) verifyPassword 迭代钳制——损坏/被改写的 password_hash（迭代 0 或超大）登录
//      得 401 而非 500，超大迭代数不变成 CPU 放大器
//   2) cron 只推有到期词的用户——sendReviewReminders 的选择 SQL 语义验证
//      （node:sqlite 直跑同款查询）+ due-count 对未来日期词返回 0
// 用法：先 `wrangler d1 execute ielts_vocab --local --persist-to .tmp-r27-state --file=schema.sql`
//       再后台 `wrangler dev --port 8788 --persist-to .tmp-r27-state`，然后 node 本脚本
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8788";
const PERSIST = process.argv[2] || ".tmp-r27-state";
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
const d1dir = path.join(PERSIST, "v3", "d1", "miniflare-D1DatabaseObject");
const dbFile = readdirSync(d1dir).find((f) => f.endsWith(".sqlite"));
const openDb = () => new DatabaseSync(path.join(d1dir, dbFile));

console.log("— verifyPassword 迭代钳制 —");
const good = jarClient();
let r = await good("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r27_good_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "注册正常账号");
r = await good("/api/auth/login", { method: "POST", body: JSON.stringify({ username: `r27_good_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "正常哈希登录不受影响");

for (const [label, hash] of [
  ["迭代数为 0", "pbkdf2:0:QUFBQUFBQUFBQUFBQUFBQQ==:QUFBQUFBQUFBQUFBQUFBQQ=="],
  ["迭代数为负", "pbkdf2:-5:QUFBQUFBQUFBQUFBQUFBQQ==:QUFBQUFBQUFBQUFBQUFBQQ=="],
  ["迭代数超大（1e12）", "pbkdf2:1000000000000:QUFBQUFBQUFBQUFBQUFBQQ==:QUFBQUFBQUFBQUFBQUFBQQ=="],
]) {
  const db = openDb();
  db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(hash, `r27_good_${suffix}`);
  db.close();
  r = await good("/api/auth/login", { method: "POST", body: JSON.stringify({ username: `r27_good_${suffix}`, password: "secret1" }) });
  ok(r.status === 401, `${label}的损坏哈希 → 401 而非 500`);
}

console.log("— cron 到期过滤：只选有到期词的用户 —");
const due = jarClient();
r = await due("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r27_due_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "注册有到期词的账号");
r = await due("/api/push/subscribe", {
  method: "POST",
  body: JSON.stringify({ endpoint: `https://push.example.com/r27-due-${suffix}`, keys: { p256dh: "a", auth: "b" } }),
});
ok(r.status === 200, "due 账号订阅成功");
r = await due("/api/wordbook", { method: "POST", body: JSON.stringify({ word: "dueword" }) });
ok(r.status === 200, "due 账号收录新词（next_review_at 空 → 到期）");

const far = jarClient();
r = await far("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r27_far_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "注册无到期词的账号");
r = await far("/api/push/subscribe", {
  method: "POST",
  body: JSON.stringify({ endpoint: `https://push.example.com/r27-far-${suffix}`, keys: { p256dh: "a", auth: "b" } }),
});
ok(r.status === 200, "far 账号订阅成功");
r = await far("/api/wordbook", { method: "POST", body: JSON.stringify({ word: "farword" }) });
ok(r.status === 200, "far 账号收录新词");
const wb = await far("/api/wordbook");
const farWordId = (wb.data.words || []).find((w) => w.word === "farword")?.id;
r = await far("/api/wordbook/review", {
  method: "POST",
  body: JSON.stringify({ id: farWordId, familiarity: 5, graded_as: "know", next_review_at: "2099-01-01 12:00:00", review_date: "2026-09-06" }),
});
ok(r.status === 200, "far 账号把词排到 2099 年复习");

r = await far("/api/push/due-count");
ok(r.status === 200 && r.data.due === 0, "due-count 对未来日期词返回 0");
r = await due("/api/push/due-count");
ok(r.status === 200 && r.data.due === 1, "due-count 对到期词返回 1");

// 与 sendReviewReminders 相同的选择语句，node:sqlite 直跑验证语义
const db = openDb();
const utc8Today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const selected = db
  .prepare(
    `SELECT DISTINCT ps.endpoint FROM push_subscriptions ps
     JOIN wordbook w ON w.user_id = ps.user_id
     WHERE w.next_review_at = '' OR substr(w.next_review_at, 1, 10) <= ?
     ORDER BY ps.id`
  )
  .all(utc8Today);
db.close();
ok(
  selected.length === 1 && selected[0].endpoint === `https://push.example.com/r27-due-${suffix}`,
  "提醒选择语句只命中有到期词的账号"
);

console.log(`\nr27 冒烟：${passed} 项全部通过`);
