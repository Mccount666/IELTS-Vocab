// 第六轮 API 冒烟：文档重命名 + 文档内句子检索 + 粘贴追加（position 续接）+ 权限隔离
// 用法：先起 `npx wrangler dev --port 8788 --persist-to .tmp-r6-state`（全新 schema 库），再 node 本脚本
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

console.log("— 注册两个账号 —");
const alice = jarClient();
const bob = jarClient();
let r = await alice("/api/auth/register", { method: "POST", body: JSON.stringify({ username: "r6_alice", password: "secret1" }) });
ok(r.status === 200 && r.data.user?.is_admin === true, "alice 注册成功且为首任站长");
r = await bob("/api/auth/register", { method: "POST", body: JSON.stringify({ username: "r6_bob", password: "secret2" }) });
ok(r.status === 200 && r.data.user?.is_admin === false, "bob 注册成功非站长");

console.log("— 建文档 + 首批句子 —");
r = await alice("/api/documents", { method: "POST", body: JSON.stringify({ filename: "剑桥真题 15", exam_type: "IELTS" }) });
const docId = r.data.id;
ok(docId > 0, "alice 建文档");
r = await alice(`/api/documents/${docId}/sentences`, {
  method: "POST",
  body: JSON.stringify({
    sentences: [
      { text: "The government has abandoned the proposal amid fierce criticism.", tokens: ["the", "government", "has", "abandoned", "the", "proposal", "amid", "fierce", "criticism"] },
      { text: "Urban sustainability requires deliberate long-term planning.", tokens: ["urban", "sustainability", "requires", "deliberate", "long-term", "planning"] },
    ],
  }),
});
ok(r.status === 200 && r.data.start === 0, "首批 2 句从 position 0 开始");

console.log("— 文档重命名 PATCH /api/documents/:id —");
r = await alice(`/api/documents/${docId}`, { method: "PATCH", body: JSON.stringify({ filename: "剑桥雅思真题 15（重命名）" }) });
ok(r.status === 200 && r.data.ok === true, "重命名成功");
r = await alice("/api/documents");
ok(r.data.documents?.[0]?.filename === "剑桥雅思真题 15（重命名）", "文档列表反映新名字");
r = await alice(`/api/documents/${docId}`, { method: "PATCH", body: JSON.stringify({ filename: "   " }) });
ok(r.status === 400, "空文件名 → 400");
r = await bob(`/api/documents/${docId}`, { method: "PATCH", body: JSON.stringify({ filename: "bob 的恶意改名" }) });
ok(r.status === 404, "bob 改 alice 的文档 → 404 越权拦截");
r = await alice(`/api/documents/${docId}`, { method: "PATCH", body: JSON.stringify({}) });
ok(r.status === 400, "缺 filename → 400");

console.log("— 文档内句子检索 GET /api/documents/:id/sentences —");
r = await alice(`/api/documents/${docId}/sentences`);
ok(r.status === 200 && r.data.total === 2 && r.data.sentences.length === 2, "列出全部 2 句且 total 正确");
ok(r.data.sentences[0].position === 0 && r.data.sentences[1].position === 1, "按 position 升序");
r = await alice(`/api/documents/${docId}/sentences?q=abandoned`);
ok(r.data.total === 1 && r.data.sentences[0].text.includes("abandoned"), "q=abandoned 命中 1 句（LIKE 大小写不敏感）");
r = await alice(`/api/documents/${docId}/sentences?q=GOVERNMENT`);
ok(r.data.total === 1 && r.data.sentences[0].text.includes("government"), "q 大写也能命中");
r = await alice(`/api/documents/${docId}/sentences?q=不存在的词`);
ok(r.data.total === 0 && r.data.sentences.length === 0, "无命中返回空");
r = await alice(`/api/documents/${docId}/sentences?limit=1`);
ok(r.data.limit === 1 && r.data.sentences.length === 1 && r.data.total === 2, "limit=1 只回 1 句但 total 仍是 2");
r = await bob(`/api/documents/${docId}/sentences`);
ok(r.status === 404, "bob 读 alice 的文档句子 → 404");
r = await alice("/api/documents/99999/sentences");
ok(r.status === 404, "不存在的文档 → 404");

console.log("— 追加导入（position 续接 + 索引可用）—");
r = await alice(`/api/documents/${docId}/sentences`, {
  method: "POST",
  body: JSON.stringify({
    sentences: [
      { text: "She yielded to the temptation of a second dessert.", tokens: ["she", "yielded", "to", "the", "temptation", "of", "a", "second", "dessert"] },
      { text: "Resilience is what separates survivors from casualties.", tokens: ["resilience", "is", "what", "separates", "survivors", "from", "casualties"] },
    ],
  }),
});
ok(r.status === 200 && r.data.start === 2 && r.data.inserted === 2 && r.data.ids?.length === 2, "追加 2 句从 position 2 续接并返回 ids");
r = await alice(`/api/documents/${docId}/sentences`);
ok(r.data.total === 4, "追加后文档共 4 句");
r = await alice("/api/search?word=yield");
ok(r.data.sentences?.length === 1 && r.data.sentences[0].text.includes("yielded"), "追加句子的倒排索引生效（查 yield 命中 yielded 句）");
r = await alice("/api/search?word=resilience");
ok(r.data.sentences?.length === 1, "追加句子 resilience 可查");
// 重命名后的文档名出现在搜索结果的来源里
r = await alice("/api/search?word=yield");
ok(r.data.sentences?.[0]?.filename === "剑桥雅思真题 15（重命名）", "搜索结果来源显示重命名后的文档名");

console.log("— 收录追加句子的生词 + 统计窗口 —");
r = await alice("/api/wordbook", { method: "POST", body: JSON.stringify({ word: "resilience", translation: "复原力", sentence_id: r.data.sentences[0].id }) });
ok(r.status === 200 && r.data.id > 0, "收录 resilience 挂追加例句");
r = await alice("/api/stats?since=2026-01-01");
ok(r.status === 200 && r.data.total_reviews === 0, "旧 since 窗口也能正常聚合（累计 0）");
r = await alice("/api/wordbook");
const wbx = r.data.words.find((w) => w.word === "resilience");
ok(wbx?.source_file === "剑桥雅思真题 15（重命名）" && wbx?.exam_type === "IELTS", "生词本条目带回重命名后的来源与考试类型");

console.log("— wordbook GET 仍含 SRS 字段（回归）—");
ok("next_review_at" in wbx && "familiarity" in wbx, "next_review_at / familiarity 字段仍在");

console.log(`\n通过 ${passed} 项断言`);
if (process.exitCode) console.error("存在失败断言！");
