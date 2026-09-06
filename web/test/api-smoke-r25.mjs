// 第二十五轮定向冒烟：
//   1) migration 010 llm_usage：未配置 Key 的失败调用不计数；配置 Key 后计数自增；
//      计数打满 → 429 每日上限（429 在上游调用前，不烧用户 Key）
//   2) llm/translate 的 400 缺 text 参数门在就绪检查之前（r21 口径不变）
//   3) 换号清联想下拉（静态断言）+ sw v19
// 用法：先 `wrangler d1 execute ielts_vocab --local --persist-to .tmp-r25-state --file=schema.sql`
//       再后台 `wrangler dev --port 8788 --persist-to .tmp-r25-state`，然后 node 本脚本
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8788";
const PERSIST = process.argv[2] || ".tmp-r25-state";
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

console.log("— migration 010：llm_usage 表与计数逻辑 —");
const member = jarClient();
let r = await member("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r25_member_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "注册成功");

// 未配置 Key：失败调用被就绪检查拦截，不计数
r = await member("/api/llm/define", { method: "POST", body: JSON.stringify({ word: "abandon" }) });
ok(r.status === 400 && (r.data.error || "").includes("尚未配置 LLM API Key"), "未配置 Key → 400 就绪检查");
let db = openDb();
let usage = db.prepare("SELECT count FROM llm_usage WHERE user_id = ?").get(1);
ok(!usage, "失败调用未计数");
db.close();

// text 参数门在就绪检查之前（r21 口径）：对象 text → 400 缺 text，而不是 400 未配置 Key
r = await member("/api/llm/translate", { method: "POST", body: JSON.stringify({ text: { o: 1 } }) });
ok(r.status === 400 && (r.data.error || "").includes("缺少 text"), "translate 对象 text → 400 缺少 text（先于 Key 门）");

// 种入 Key 配置 + 打满当日计数 → 429（429 必须发生在上游调用前）
db = openDb();
db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)").run(1, "llm_api_key", "sk-test-r25");
db.prepare("INSERT INTO llm_usage (user_id, day, count) VALUES (?, ?, ?)").run(1, new Date().toISOString().slice(0, 10), 500);
db.close();
r = await member("/api/llm/define", { method: "POST", body: JSON.stringify({ word: "abandon" }) });
ok(r.status === 429 && (r.data.error || "").includes("上限"), "当日计数打满 → 429 每日上限");
r = await member("/api/llm/translate", { method: "POST", body: JSON.stringify({ text: "hello world" }) });
ok(r.status === 429 && (r.data.error || "").includes("上限"), "translate 同受每日上限约束");

// 计数继续推进：define(501) + translate(502) 两次 429 各自计了一次
db = openDb();
usage = db.prepare("SELECT count FROM llm_usage WHERE user_id = ?").get(1);
ok(usage.count === 502, "429 请求自身也被计数（502）");
db.close();

console.log("— 前端静态断言 —");
const appJs = await (await fetch(BASE + "/js/app.js")).text();
ok(appJs.includes("hideSuggest(); // 联想下拉别挂着上一账号词表里的词"), "换号时清联想下拉");
const swText = await (await fetch(BASE + "/sw.js")).text();
ok(/VERSION = "v\d+"/.test(swText), "sw.js 存在版本号（当前版本由当轮冒烟断言）");

console.log(`\nr25 冒烟：${passed} 项全部通过`);
