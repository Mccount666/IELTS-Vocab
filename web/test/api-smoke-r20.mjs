// 第二十轮定向冒烟：mineru/download Token 门、wordbook 写入字段类型门（对象不再变
// "[object Object]" 入库）、复习流程与统计回归、词典缓存读路径回归。
// 说明（无法端到端构造、由代码评审/单测保证）：
//   - 词典缓存所有权 upsert（用户级写入不覆盖可信共享行）需要真实 LLM/在线词典上游，
//     本地无法触发；SQL 语义已用 node:sqlite 按同一 D1/SQLite 版本单测验证。
//   - review_log 每日上限（2000 次/日）触发需要 2000 次请求，冒烟只验证正常复习路径不受影响。
// 用法：先起 `npx wrangler dev --port 8788 --persist-to .tmp-r20-state`（全新 schema 库），再 node 本脚本
const BASE = "http://127.0.0.1:8788";
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

console.log("— 注册与基础数据 —");
const admin = jarClient();
let r = await admin("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r20_admin_${suffix}`, password: "secret1" }) });
ok(r.status === 200 && r.data.user?.is_admin === true, "首个注册账号成为站长");
const member = jarClient();
r = await member("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r20_member_${suffix}`, password: "secret1" }) });
ok(r.status === 200 && r.data.user?.is_admin === false, "第二个注册账号为普通用户");

console.log("— mineru/download Token 门（与 upload/轮询同一口径） —");
r = await member(`/api/mineru/download?url=${encodeURIComponent("https://mineru.net/api/v4/x.zip")}`);
ok(r.status === 400 && String(r.data.error || "").includes("尚未配置"), "未配置 Token → 400 拒绝（白名单地址也不例外）");

console.log("— wordbook 字段类型门：非 string 字段丢弃而非 String() 兜底 —");
r = await member("/api/wordbook", {
  method: "POST",
  body: JSON.stringify({ word: "typeguard", phonetic: { evil: 1 }, translation: ["arr"], definition: 42 }),
});
ok(r.status === 200, "POST phonetic/translation/definition 传对象/数组/数字 → 200");
r = await member("/api/wordbook");
const tg = (r.data.words || []).find((w) => w.word === "typeguard");
ok(!!tg && tg.phonetic === "" && tg.translation === "" && tg.definition === "", "三个字段均落库为空串（无 [object Object] 垃圾）");

console.log("— 复习流程回归（正常路径不受每日上限影响） —");
r = await member("/api/wordbook", { method: "POST", body: JSON.stringify({ word: "reviewword" }) });
ok(r.status === 200 && r.data.id > 0, "收录生词 reviewword");
const wbId = r.data.id;
const today = new Date().toISOString().slice(0, 10);
for (let i = 0; i < 5; i++) {
  r = await member("/api/wordbook/review", {
    method: "POST",
    body: JSON.stringify({ id: wbId, familiarity: Math.min(5, i + 1), graded_as: "know", next_review_at: "2026-09-10 12:00:00", review_date: today }),
  });
  if (r.status !== 200) break;
}
ok(r.status === 200, "连续 5 次评分均成功（未触发上限）");
r = await member(`/api/stats?since=${today}`);
ok((r.data.daily || []).find((d) => d.date === today)?.n === 5, "统计页今日复习数 = 5");
r = await member("/api/wordbook");
ok((r.data.words || []).find((w) => w.id === wbId)?.familiarity === 5, "熟悉度逐步升到 5");

console.log("— 词典缓存读路径回归（所有权过滤不破坏正常查询） —");
r = await member("/api/dictionary?word=zzqxv99nope");
ok(r.status === 200 && (r.data.definition === null || typeof r.data.definition === "object"), "未知词 → definition null（在线兜底失败也安全降级）");

console.log("— 搜索回归：索引与例句查询正常 —");
r = await member("/api/documents", { method: "POST", body: JSON.stringify({ filename: "r20 doc", exam_type: "IELTS" }) });
const docId = r.data.id;
await member(`/api/documents/${docId}/sentences`, {
  method: "POST",
  body: JSON.stringify({
    sentences: [
      { text: "The proposal was deemed egregious by the committee.", tokens: ["the", "proposal", "was", "deemed", "egregious", "by", "committee"] },
      { text: "She found the fee totally egregious.", tokens: ["she", "found", "the", "fee", "totally", "egregious"] },
    ],
  }),
});
r = await member("/api/search?word=egregious");
ok(r.status === 200 && r.data.sentences?.length === 2, "搜 egregious 命中 2 句");

console.log(`\n完成：${passed} 项通过`);
