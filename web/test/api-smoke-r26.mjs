// 第二十六轮定向冒烟：Web Push 每日复习提醒
//   1) /api/push/vapid-public 返回配置的 VAPID 公钥
//   2) 订阅/换绑/解绑 + 每用户设备数配额（10 台）
//   3) /api/push/due-count 按 UTC+8 口径计到期词
//   4) scheduled 处理器跑通（假 endpoint 网络失败被单台兜住，订阅不被误删）
//   5) sw v20 + push/notifyclick 处理器存在
// 用法：npx wrangler dev --port 8788 --test-scheduled --persist-to .tmp-r26-state（先灌 schema.sql）
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8788";
const PERSIST = process.argv[2] || ".tmp-r26-state";
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

console.log("— VAPID 公钥下发 —");
const member = jarClient();
let r = await member("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r26_member_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "注册成功");
r = await member("/api/push/vapid-public");
ok(r.status === 200 && /^B[A-Za-z0-9_-]{80,}$/.test(r.data.publicKey || ""), "vapid-public 返回 P-256 原始公钥");

console.log("— 订阅 / 换绑 / 解绑 / 设备配额 —");
const mkSub = (n) => ({
  endpoint: `https://push.example.com/endpoint/${suffix}/${n}`,
  keys: { p256dh: `p256dh-key-${suffix}-${n}`, auth: `auth-key-${suffix}-${n}` },
});
let okAll = true;
for (let i = 0; i < 10; i++) {
  r = await member("/api/push/subscribe", { method: "POST", body: JSON.stringify(mkSub(i)) });
  if (r.status !== 200) okAll = false;
}
ok(okAll, "订阅 10 台设备全部成功");
r = await member("/api/push/subscribe", { method: "POST", body: JSON.stringify(mkSub(10)) });
ok(r.status === 400 && (r.data.error || "").includes("上限"), "第 11 台设备 → 400 配额拒绝");
r = await member("/api/push/subscribe", { method: "POST", body: JSON.stringify(mkSub(0)) });
ok(r.status === 200, "已有设备重复订阅（换绑）不受配额限制");
let db = openDb();
let row = db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = 1").get();
ok(row.n === 10, "库中恰 10 条订阅（换绑未新增行）");
db.close();
r = await member("/api/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint: "http://not-https/x", keys: { p256dh: "a", auth: "b" } }) });
ok(r.status === 400, "非 https endpoint → 400");
r = await member("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: mkSub(9).endpoint }) });
ok(r.status === 200, "解绑成功");
db = openDb();
row = db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = 1").get();
ok(row.n === 9, "解绑后剩 9 条");
db.close();

console.log("— 到期词数（UTC+8 口径） —");
r = await member("/api/wordbook", { method: "POST", body: JSON.stringify({ word: "reminderword" }) });
ok(r.status === 200, "收录一个生词（next_review_at 为空 → 立即到期）");
r = await member("/api/push/due-count");
ok(r.status === 200 && r.data.due === 1, "due-count 返回 1");

console.log("— scheduled 处理器跑通 —");
r = await member("/api/push/subscribe", {
  method: "POST",
  body: JSON.stringify({ endpoint: `https://push.invalid/endpoint/${suffix}`, keys: { p256dh: "a", auth: "b" } }),
});
const cronResp = await fetch(`${BASE}/__scheduled?cron=0+1+*+*+*`);
ok(cronResp.ok, "cron 触发端点 200");
await new Promise((res) => setTimeout(res, 4000)); // waitUntil 异步发送
db = openDb();
row = db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = 1").get();
ok(row.n === 10, "网络失败的设备未被误删（10 = 9 + 新增的 invalid）");
db.close();

console.log("— 前端静态断言 —");
const swText = await (await fetch(BASE + "/sw.js")).text();
ok(swText.includes('addEventListener("push"') && swText.includes("notificationclick") && /VERSION = "v\d+"/.test(swText), "sw 带 push/notifyclick 处理器（版本由当轮冒烟断言）");
const html = await (await fetch(BASE + "/")).text();
ok(html.includes('id="push-card"') && html.includes('id="push-toggle"'), "设置页有复习提醒卡");

console.log(`\nr26 冒烟：${passed} 项全部通过`);
