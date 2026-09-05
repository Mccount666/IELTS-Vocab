// 第七轮 API 冒烟：安全加固回归 —— 句子载荷上限 + 截断、登录时序拉平（不存在用户同文案 401）、
// 删文档后生词本悬空 sentence_id 置空。
// 用法：先起 `npx wrangler dev --port 8788 --persist-to .tmp-r7-state`（全新 schema 库），再 node 本脚本
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

console.log("— 注册 —");
const suffix = Date.now().toString(36).slice(-5);
const alice = jarClient();
let r = await alice("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r7_alice_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "alice 注册成功");

console.log("— 登录时序/文案一致 —");
r = await alice("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "no_such_user", password: "wrongpw" }) });
ok(r.status === 401 && r.data.error === "用户名或密码错误", "不存在用户 → 401 同文案");
r = await alice("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "r7_alice", password: "badpw" }) });
ok(r.status === 401 && r.data.error === "用户名或密码错误", "密码错误 → 401 同文案");

console.log("— 句子载荷上限与截断 —");
r = await alice("/api/documents", { method: "POST", body: JSON.stringify({ filename: "r7 doc", exam_type: "IELTS" }) });
const docId = r.data.id;
ok(r.status === 200 && docId > 0, "创建文档");
const big = Array.from({ length: 501 }, (_, i) => ({ text: `sentence number ${i}`, tokens: [`sentence`, `number`] }));
r = await alice(`/api/documents/${docId}/sentences`, { method: "POST", body: JSON.stringify({ sentences: big }) });
ok(r.status === 400, "501 句单请求 → 400 拒绝");
const weird = [
  { text: "x".repeat(6000), tokens: ["a".repeat(100)] },      // 超长文本/词元
  { text: "normal one here", tokens: Array.from({ length: 500 }, (_, i) => `w${i}`) }, // 超量词元
];
r = await alice(`/api/documents/${docId}/sentences`, { method: "POST", body: JSON.stringify({ sentences: weird }) });
ok(r.status === 200 && r.data.inserted === 2, "异常载荷被截断后正常入库");
r = await alice(`/api/documents/${docId}/sentences?limit=10`, {});
const first = r.data.sentences?.[0]?.text || "";
ok(first.length <= 4000, `超长文本被截断（长度 ${first.length} ≤ 4000）`);

console.log("— 删文档清理生词本悬空引用 —");
r = await alice("/api/documents", { method: "POST", body: JSON.stringify({ filename: "r7 doc2", exam_type: "IELTS" }) });
const doc2 = r.data.id;
r = await alice(`/api/documents/${doc2}/sentences`, {
  method: "POST",
  body: JSON.stringify({ sentences: [{ text: "The quick brown fox jumps.", tokens: ["quick", "brown", "fox", "jumps"] }] }),
});
const sid = r.data.ids[0];
r = await alice("/api/wordbook", {
  method: "POST",
  body: JSON.stringify({ word: "fox", sentence_id: sid, translation: "狐狸" }),
});
ok(r.status === 200, "收藏带例句的生词");
r = await alice(`/api/documents/${doc2}`, { method: "DELETE" });
ok(r.status === 200, "删除文档");
r = await alice("/api/wordbook", {});
const fox = r.data.words.find((w) => w.word === "fox");
ok(fox && fox.sentence_id === null && !fox.sentence_text, "删文档后生词保留且 sentence_id 已置空");

console.log(`\n${passed} 项全部通过` + (process.exitCode ? "（存在失败）" : ""));
