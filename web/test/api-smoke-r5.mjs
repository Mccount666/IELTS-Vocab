// 第五轮 API 冒烟：SRS 调度 + review_log 统计 + 批量操作 + 恢复保留 next_review_at
// 用法：先起 `npx wrangler dev --port 8788 --persist-to .tmp-test-state`（全新 schema 库），再 node 本脚本
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

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const plusDays = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 12:00:00`;
};

console.log("— 注册两个账号 —");
const alice = jarClient();
const bob = jarClient();
let r = await alice("/api/auth/register", { method: "POST", body: JSON.stringify({ username: "srs_alice", password: "secret1" }) });
ok(r.status === 200 && r.data.user?.is_admin === true, "alice 注册成功且为首任站长");
r = await bob("/api/auth/register", { method: "POST", body: JSON.stringify({ username: "srs_bob", password: "secret2" }) });
ok(r.status === 200 && r.data.user?.is_admin === false, "bob 注册成功非站长");

console.log("— 建文档 + 句子（两个账号各一份）—");
for (const [client, name] of [[alice, "alice 真题"], [bob, "bob 真题"]]) {
  r = await client("/api/documents", { method: "POST", body: JSON.stringify({ filename: name, exam_type: "IELTS" }) });
  const docId = r.data.id;
  r = await client(`/api/documents/${docId}/sentences`, {
    method: "POST",
    body: JSON.stringify({
      sentences: [
        { text: "The government has abandoned the proposal amid fierce criticism.", tokens: ["the", "government", "has", "abandoned", "the", "proposal", "amid", "fierce", "criticism"] },
        { text: "Urban sustainability requires deliberate long-term planning.", tokens: ["urban", "sustainability", "requires", "deliberate", "long-term", "planning"] },
      ],
    }),
  });
  ok(r.status === 200 && r.data.inserted === 2 && Array.isArray(r.data.ids) && r.data.ids.length === 2, `${name} 导入 2 句并返回 ids`);
}

console.log("— 生词本收录 + 复习评分（SRS 调度）—");
// alice：3 个生词；第一个用文档例句
r = await alice("/api/search?word=abandon");
const sentId = r.data.sentences?.[0]?.id;
ok(Boolean(sentId), "alice 查 abandon 拿到例句 id");
for (const [word, sid] of [["abandon", sentId], ["sustainable", null], ["deliberate", null]]) {
  r = await alice("/api/wordbook", { method: "POST", body: JSON.stringify({ word, phonetic: "", translation: "测试释义", definition: "def", sentence_id: sid || undefined }) });
  ok(r.status === 200 && r.data.id > 0, `收录 ${word}`);
}
r = await alice("/api/wordbook");
const wb = r.data.words;
ok(wb.length === 3, "alice 生词本 3 个词");
ok(wb.every((w) => w.next_review_at === ""), "新词 next_review_at 为空 = 立即到期");

const abandonId = wb.find((w) => w.word === "abandon").id;
const sustainId = wb.find((w) => w.word === "sustainable").id;
// 认识 → 熟悉度 1，下次 4 天后（SRS_INTERVALS[1]）
r = await alice("/api/wordbook/review", { method: "POST", body: JSON.stringify({ id: abandonId, familiarity: 1, graded_as: "know", next_review_at: plusDays(4), review_date: today() }) });
ok(r.status === 200 && r.data.next_review_at === plusDays(4), "abandon 认识：next_review_at = 4 天后");
// 忘记 → 明天
r = await alice("/api/wordbook/review", { method: "POST", body: JSON.stringify({ id: sustainId, familiarity: 0, graded_as: "forget", next_review_at: plusDays(1), review_date: today() }) });
ok(r.status === 200, "sustainable 忘记：明天再见");
r = await alice("/api/wordbook/review", { method: "POST", body: JSON.stringify({ id: 99999, familiarity: 1, graded_as: "know", next_review_at: plusDays(1) }) });
ok(r.status === 404, "复习别人的/不存在的词 → 404");
r = await alice("/api/wordbook/review", { method: "POST", body: JSON.stringify({ id: abandonId, familiarity: 1, graded_as: "know", next_review_at: "not-a-date" }) });
ok(r.status === 400, "next_review_at 格式非法 → 400");

console.log("— 到期统计与筛选口径 —");
r = await alice("/api/wordbook");
const wb2 = r.data.words;
const dueCount = wb2.filter((w) => !w.next_review_at || w.next_review_at.slice(0, 10) <= today()).length;
ok(dueCount === 1, "3 词中 2 词已排到未来（4 天后/明天），只剩 1 个今日到期");
ok(wb2.find((w) => w.id === abandonId).next_review_at === plusDays(4), "wordbook GET 回带 next_review_at");

console.log("— /api/stats 统计 —");
r = await alice("/api/stats?since=" + today());
ok(r.data.total_reviews === 2 && r.data.distinct_words === 2, "alice 累计复习 2 次 / 2 个不同词");
const todayRow = (r.data.daily || []).find((d) => d.date === today());
ok(todayRow?.n === 2, "今日 review_log 聚合 = 2");
r = await bob("/api/stats?since=" + today());
ok(r.data.total_reviews === 0, "bob 的统计与 alice 隔离（=0）");

console.log("— 批量操作 —");
const delibId = wb2.find((w) => w.word === "deliberate").id;
r = await alice("/api/wordbook/batch", { method: "POST", body: JSON.stringify({ action: "familiarity", familiarity: 5, ids: [delibId] }) });
ok(r.status === 200 && r.data.affected === 1, "批量设置熟悉度影响 1 行");
r = await alice("/api/wordbook");
ok(r.data.words.find((w) => w.id === delibId).familiarity === 5, "deliberate 熟悉度变 5");
ok(r.data.words.find((w) => w.id === delibId).next_review_at === "", "批量调熟悉度不动 SRS 计划");
r = await alice("/api/wordbook/batch", { method: "POST", body: JSON.stringify({ action: "familiarity", familiarity: 1, ids: [abandonId] }) });
// bob 试图删 alice 的词 → 0 行受影响
r = await bob("/api/wordbook/batch", { method: "POST", body: JSON.stringify({ action: "delete", ids: [abandonId, sustainId] }) });
ok(r.data.affected === 0, "bob 批量删 alice 的词 → 越权拦截（0 行）");
r = await alice("/api/wordbook/batch", { method: "POST", body: JSON.stringify({ action: "delete", ids: [delibId] }) });
ok(r.data.affected === 1, "alice 批量删除自己的词");
r = await alice("/api/wordbook");
ok(r.data.words.length === 2, "删除后生词本剩 2 个");
r = await alice("/api/wordbook/batch", { method: "POST", body: JSON.stringify({ action: "nuke", ids: [abandonId] }) });
ok(r.status === 400, "未知 action → 400");

console.log("— 备份导出/恢复保留 SRS 计划 —");
// 用 bob 模拟备份 JSON（带 next_review_at），导入回 bob 自己
r = await bob("/api/wordbook", { method: "POST", body: JSON.stringify({ word: "legacy", translation: "旧词" }) });
const legacyId = r.data.id;
await bob("/api/wordbook/review", { method: "POST", body: JSON.stringify({ id: legacyId, familiarity: 3, graded_as: "fuzzy", next_review_at: plusDays(8), review_date: today() }) });
// 模拟备份：直接构造（导出接口也会带 next_review_at，因为 SELECT *）
const backup = {
  documents: [{ id: 1, filename: "备份真题", exam_type: "TOEFL", imported_at: "2026-01-01 00:00:00" }],
  sentences: [{ id: 1, document_id: 1, text: "Restored sentence about resilience.", position: 0 }],
  wordbook: [{ word: "resilience", familiarity: 4, next_review_at: plusDays(16), last_reviewed_at: "2026-01-02 00:00:00", added_at: "2026-01-01 00:00:00", sentence_id: 1, translation: "复原力" }],
  user_settings: [],
};
r = await bob("/api/documents", { method: "POST", body: JSON.stringify({ filename: backup.documents[0].filename, exam_type: "TOEFL" }) });
const newDocId = r.data.id;
r = await bob(`/api/documents/${newDocId}/sentences`, { method: "POST", body: JSON.stringify({ sentences: [{ text: backup.sentences[0].text, tokens: ["restored", "sentence", "about", "resilience"] }] }) });
const newSid = r.data.ids[0];
r = await bob("/api/wordbook/restore", { method: "POST", body: JSON.stringify({ words: [{ ...backup.wordbook[0], sentence_id: newSid }] }) });
ok(r.status === 200 && r.data.restored === 1, "恢复 1 个生词");
r = await bob("/api/wordbook");
const restored = r.data.words.find((w) => w.word === "resilience");
ok(restored?.next_review_at === plusDays(16), "恢复保留 next_review_at（SRS 计划不丢）");
ok(restored?.familiarity === 4 && restored?.sentence_id === newSid, "恢复保留熟悉度并挂上新例句");
r = await bob("/api/wordbook/restore", { method: "POST", body: JSON.stringify({ words: [{ word: "hack", sentence_id: sentId }] }) });
r = await bob("/api/wordbook");
ok(r.data.words.find((w) => w.word === "hack")?.sentence_id == null, "恢复引用别人文档的句子 → 降级无例句");

console.log(`\n通过 ${passed} 项断言`);
if (process.exitCode) console.error("存在失败断言！");
