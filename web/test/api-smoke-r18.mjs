// 第十八轮定向冒烟：每用户数据配额（文档 500 / 单文档 2 万句 / 生词 2 万）。
// 配额阈值是硬编码常量，只能靠打满验证：请求量大，跑完约 1-2 分钟属预期。
// 用法：先起 `npx wrangler dev --port 8788 --persist-to .tmp-r18-state`（全新 schema 库），再 node 本脚本
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

// 并发小助手：分批并发跑，避免一次打几千个并发把 dev server 压垮
async function pool(items, worker, concurrency = 8) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    results.push(...(await Promise.all(items.slice(i, i + concurrency).map(worker))));
  }
  return results;
}

console.log("— 注册测试账号 —");
const quota = jarClient();
let r = await quota("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ username: `r18_quota_${suffix}`, password: "secret1" }),
});
ok(r.status === 200, "测试账号注册成功");

console.log("— 文档数配额（500 份） —");
// 先打满 500 份（第 1 份已建则再建 499 份），断言第 501 份被拒
const docsBefore = (await quota("/api/documents")).data.documents.length;
const need = 500 - docsBefore;
const docResults = await pool(
  Array.from({ length: need }, (_, i) => i),
  (i) =>
    quota("/api/documents", {
      method: "POST",
      body: JSON.stringify({ filename: `r18 doc ${i}`, exam_type: "Other" }),
    }),
  10
);
ok(docResults.every((d) => d.status === 200), `补建 ${need} 份文档全部成功`);
const docList = (await quota("/api/documents")).data.documents;
ok(docList.length === 500, `文档数恰为 500（实际 ${docList.length}）`);
r = await quota("/api/documents", { method: "POST", body: JSON.stringify({ filename: "r18 over", exam_type: "Other" }) });
ok(r.status === 400 && /上限/.test(r.data.error || ""), "第 501 份文档 → 400 配额拒绝");
// 删 1 份后应可再建（配额按当前存量算，不是一次性总额度）
const victim = docList[0];
await quota(`/api/documents/${victim.id}`, { method: "DELETE" });
r = await quota("/api/documents", { method: "POST", body: JSON.stringify({ filename: "r18 after delete", exam_type: "Other" }) });
ok(r.status === 200, "删除 1 份后可再次创建");

console.log("— 单文档句子配额（20000 句） —");
// 用刚建的文档：50 × 400 句正好打满，第 51 批被拒
const capDocId = r.data.id;
const chunk = Array.from({ length: 400 }, () => ({
  text: "The quick brown fox jumps over the lazy dog near the river bank every morning.",
  tokens: ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "near", "river", "bank", "every", "morning"],
}));
const upResults = await pool(
  Array.from({ length: 50 }, () => chunk),
  (c) => quota(`/api/documents/${capDocId}/sentences`, { method: "POST", body: JSON.stringify({ sentences: c }) }),
  5
);
ok(upResults.every((u) => u.status === 200), "50 批 × 400 句全部入库");
r = await quota(`/api/documents/${capDocId}/sentences?limit=1`);
ok(r.data.total === 20000, `文档内句子总数恰为 20000（实际 ${r.data.total}）`);
r = await quota(`/api/documents/${capDocId}/sentences`, {
  method: "POST",
  body: JSON.stringify({ sentences: [{ text: "one sentence too many.", tokens: ["one"] }] }),
});
ok(r.status === 400 && /上限/.test(r.data.error || ""), "第 20001 句 → 400 配额拒绝");
// 被拒的请求不该留下已自增的 position 区间：句内搜索总量仍是 20000
r = await quota(`/api/documents/${capDocId}/sentences?limit=1`);
ok(r.data.total === 20000, "配额拒绝后 next_pos 未被污染（总量仍 20000）");
// 换一个不存在的文档：仍是 404 而不是被配额分支吞掉
r = await quota("/api/documents/999999/sentences", {
  method: "POST",
  body: JSON.stringify({ sentences: [{ text: "x", tokens: [] }] }),
});
ok(r.status === 404, "不存在的文档仍是 404");

console.log("— 生词数配额（20000 个） —");
// 恢复路径每次最多 200 行：100 批正好打满
const wbBatches = Array.from({ length: 100 }, (_, b) =>
  Array.from({ length: 200 }, (_, i) => ({ word: `r18w${b * 200 + i}` }))
);
const restoreResults = await pool(
  wbBatches,
  (words) => quota("/api/wordbook/restore", { method: "POST", body: JSON.stringify({ words }) }),
  5
);
ok(restoreResults.every((u) => u.status === 200), "100 批 × 200 词全部恢复");
r = await quota("/api/wordbook");
ok((r.data.words || []).length === 20000, `生词总数恰为 20000（实际 ${(r.data.words || []).length}）`);
r = await quota("/api/wordbook/restore", { method: "POST", body: JSON.stringify({ words: [{ word: "r18overflow" }] }) });
ok(r.status === 400 && /上限/.test(r.data.error || ""), "恢复超出上限 → 400 配额拒绝");
r = await quota("/api/wordbook", { method: "POST", body: JSON.stringify({ word: "r18newword" }) });
ok(r.status === 400 && /上限/.test(r.data.error || ""), "新词收录 → 400 配额拒绝");
// 已有词的更新不受配额限制（补释义 / 挂例句是正常操作）
r = await quota("/api/wordbook", { method: "POST", body: JSON.stringify({ word: "r18w0", translation: "已存在的词补释义" }) });
ok(r.status === 200 && r.data.ok === true, "已有词的更新不受配额限制");

console.log(`\n${passed} 项全部通过` + (process.exitCode ? "（存在失败）" : ""));
