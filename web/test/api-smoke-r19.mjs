// 第十九轮定向冒烟：注册码常量时间比较（行为不变性）、句子 token 字符集门（全局 words 表防污染）、
// 删文档的悬空引用置空 + 孤儿词清理（跨用户共享词形存活验证）。
// 说明：/api/mineru/upload 的 Content-Length 类型门（NaN/负数 → 400）无法端到端构造——
// undici 会在客户端拒绝伪造的 content-length，workerd 对非法值也在 Worker 之前就 500，
// 该校验属纵深防御，由代码评审保证。
// 用法：先起 `npx wrangler dev --port 8788 --persist-to .tmp-r19-state`（全新 schema 库），再 node 本脚本
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

console.log("— 注册码：错误码拒绝 / 正确码放行（timingSafeEqualStr 行为不变性） —");
const admin = jarClient();
let r = await admin("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r19_admin_${suffix}`, password: "secret1" }) });
ok(r.status === 200 && r.data.user?.is_admin === true, "首个注册账号成为站长");
r = await admin("/api/admin/site-settings", {
  method: "POST",
  body: JSON.stringify({ registration_code: "r19-code-★" }),
});
ok(r.status === 200, "站长开启注册码");
const wrong = jarClient();
r = await wrong("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ username: `r19_bad_${suffix}`, password: "secret1", reg_code: "wrong-code" }),
});
ok(r.status === 403, "错误注册码 → 403");
const member = jarClient();
r = await member("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ username: `r19_ok_${suffix}`, password: "secret1", reg_code: "r19-code-★" }),
});
ok(r.status === 200, "正确注册码 → 注册成功");

console.log("— token 字符集门：非英文 token 不进索引 —");
r = await member("/api/documents", { method: "POST", body: JSON.stringify({ filename: "r19 doc A", exam_type: "IELTS" }) });
const docA = r.data.id;
ok(r.status === 200 && docA > 0, "member 建文档 A");
r = await member(`/api/documents/${docA}/sentences`, {
  method: "POST",
  body: JSON.stringify({
    sentences: [
      { text: "I don't like it.", tokens: ["don't"] },
      { text: "junk token here.", tokens: ["中文词", "with space", "x'y'z!", "don't"] },
    ],
  }),
});
const idsA = r.data.ids || [];
ok(r.status === 200 && r.data.inserted === 2, "含垃圾 token 的句子导入成功");
r = await member("/api/wordbook", { method: "POST", body: JSON.stringify({ word: "don't", sentence_id: idsA[0] }) });
ok(r.status === 200, "收藏 don't 并挂例句（攒一个悬空引用待删文档验证）");
// 收录的是 sentence A[0]；r19_docAword 是只出现在文档 A 的词，删文档后应成孤儿
r = await member(`/api/documents/${docA}/sentences`, {
  method: "POST",
  body: JSON.stringify({ sentences: [{ text: "orphanwordtest appears once.", tokens: ["orphanwordtest"] }] }),
});
ok(r.status === 200, "文档 A 追加孤儿词句");

console.log("— 删文档：悬空引用置空 + 共享词形跨用户存活 —");
r = await member("/api/documents", { method: "POST", body: JSON.stringify({ filename: "r19 doc B", exam_type: "Other" }) });
const docB = r.data.id;
r = await member(`/api/documents/${docB}/sentences`, {
  method: "POST",
  body: JSON.stringify({ sentences: [{ text: "orphanwordtest also in doc B for member.", tokens: ["orphanwordtest"] }] }),
});
ok(r.status === 200, "member 建文档 B 并写入同一个词（共享词形）");
r = await admin("/api/documents", { method: "POST", body: JSON.stringify({ filename: "r19 doc C", exam_type: "GRE" }) });
const docC = r.data.id;
r = await admin(`/api/documents/${docC}/sentences`, {
  method: "POST",
  body: JSON.stringify({ sentences: [{ text: "orphanwordtest in admin doc C.", tokens: ["orphanwordtest"] }] }),
});
ok(r.status === 200, "admin 建文档 C 并写入同一个词");
r = await member(`/api/documents/${docA}`, { method: "DELETE" });
ok(r.status === 200, "member 删除文档 A");
r = await member("/api/wordbook");
const wbDonT = (r.data.words || []).find((w) => w.word === "don't");
ok(wbDonT && wbDonT.sentence_id === null && !wbDonT.sentence_text, "删文档后生词本的例句引用被置空");
r = await member("/api/search?word=orphanwordtest");
ok((r.data.sentences || []).length === 1, "文档 A 删除后，词形因文档 B 仍引用而存活（搜到 B 的句子）");
r = await member(`/api/documents/${docB}`, { method: "DELETE" });
r = await admin(`/api/documents/${docC}`, { method: "DELETE" });
ok(r.status === 200, "两份引用文档全部删除");
r = await member("/api/search?word=orphanwordtest");
ok((r.data.sentences || []).length === 0, "最后一个引用删除后，该词不再命中任何句子");

console.log(`\n${passed} 项全部通过` + (process.exitCode ? "（存在失败）" : ""));
