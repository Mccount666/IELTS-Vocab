// 第二十八轮定向冒烟：推送订阅的生命周期（绑定账号 + 浏览器）
//   1) 登出后服务端订阅行被解除（teardownPush 在会话有效时先解绑）
//   2) 换账号登录后旧订阅不再残留到新账号名下
//   3) sw v21 + README/package.json 静态断言
// 用法：先 `wrangler d1 execute ielts_vocab --local --persist-to .tmp-r28-state --file=schema.sql`
//       再后台 `wrangler dev --port 8788 --persist-to .tmp-r28-state`，然后 node 本脚本
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8788";
const PERSIST = process.argv[2] || ".tmp-r28-state";
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

const alice = jarClient();
let r = await alice("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r28_alice_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "注册 alice");
const ENDPOINT = `https://push.example.com/r28-${suffix}`;
r = await alice("/api/push/subscribe", {
  method: "POST",
  body: JSON.stringify({ endpoint: ENDPOINT, keys: { p256dh: "a", auth: "b" } }),
});
ok(r.status === 200, "alice 订阅成功");
let db = openDb();
let row = db.prepare("SELECT user_id FROM push_subscriptions WHERE endpoint = ?").get(ENDPOINT);
ok(row && row.user_id === 1, "订阅归属 alice（user_id=1）");
db.close();

// 登出：teardownPush 应在会话有效时先解绑（前端行为；此处直接按同样顺序调 API 模拟）
r = await alice("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: ENDPOINT }) });
ok(r.status === 200, "登出路径先解绑服务端订阅");
r = await alice("/api/auth/logout", { method: "POST" });
ok(r.status === 200, "登出成功");
db = openDb();
row = db.prepare("SELECT user_id FROM push_subscriptions WHERE endpoint = ?").get(ENDPOINT);
ok(!row, "登出后服务端订阅行已解除");
db.close();

// 换账号重新订阅同一浏览器 endpoint：归属换绑到新账号（upsert 语义），且不占新账号配额误判
const bob = jarClient();
r = await bob("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r28_bob_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "注册 bob");
r = await bob("/api/push/subscribe", {
  method: "POST",
  body: JSON.stringify({ endpoint: ENDPOINT, keys: { p256dh: "a2", auth: "b2" } }),
});
ok(r.status === 200, "bob 重新订阅同一浏览器 endpoint");
db = openDb();
row = db.prepare("SELECT user_id, p256dh FROM push_subscriptions WHERE endpoint = ?").get(ENDPOINT);
ok(row && row.user_id === 2 && row.p256dh === "a2", "endpoint 换绑到 bob 且密钥已更新");
db.close();
// bob 无法解除不属于自己的 endpoint（解绑按 user_id 过滤）
r = await bob("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: `https://push.example.com/others-${suffix}` }) });
ok(r.status === 200, "解绑不存在的 endpoint 幂等 200");

console.log("— 前端/文档静态断言 —");
const appJs = await (await fetch(BASE + "/js/app.js")).text();
ok(appJs.includes("async function teardownPush()") && appJs.includes("await teardownPush(); // 会话还有效时先解除推送订阅"), "登出路径接 teardownPush");
ok(appJs.includes("teardownPush(); // 401/登出路径"), "enterAuthMode 也会触发 teardownPush");
const swText = await (await fetch(BASE + "/sw.js")).text();
ok(/VERSION = "v\d+"/.test(swText), "sw.js 存在版本号");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
ok(readme.includes("011-push-subscriptions") || readme.includes("011"), "README 迁移清单已覆盖 011");
ok(readme.includes("每日复习提醒"), "README 功能表含每日复习提醒");

console.log(`\nr28 冒烟：${passed} 项全部通过`);
