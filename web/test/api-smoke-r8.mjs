// 第八轮 API 冒烟：并发追加 position 唯一性（005 next_pos 计数器）、
// LLM Base URL 内网地址校验（SSRF 硬化）、mineru/upload 未配置 Token 拒绝。
// 用法：先起 `npx wrangler dev --port 8788 --persist-to .tmp-r8-state`（全新 schema 库），再 node 本脚本
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
let r = await alice("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r8_alice_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "alice 注册成功");

console.log("— 并发追加：position 不重不漏 —");
r = await alice("/api/documents", { method: "POST", body: JSON.stringify({ filename: "r8 doc", exam_type: "IELTS" }) });
const docId = r.data.id;
ok(r.status === 200 && docId > 0, "创建文档");
const WAVES = 4;
const PER = 30;
const results = await Promise.all(
  Array.from({ length: WAVES }, (_, w) =>
    alice(`/api/documents/${docId}/sentences`, {
      method: "POST",
      body: JSON.stringify({
        sentences: Array.from({ length: PER }, (_, i) => ({
          text: `wave ${w} sentence ${i}`,
          tokens: [`wave`, `sentence`],
        })),
      }),
    })
  )
);
ok(results.every((x) => x.status === 200 && x.data.inserted === PER), `${WAVES} 个并发追加请求全部成功`);
r = await alice(`/api/documents/${docId}/sentences?limit=200`, {});
const positions = r.data.sentences.map((s) => s.position);
ok(r.data.total === WAVES * PER, `共 ${WAVES * PER} 句全部入库（实际 ${r.data.total}）`);
ok(new Set(positions).size === positions.length, `position 无重复（${positions.length} 个唯一值）`);
ok(Math.min(...positions) === 0 && Math.max(...positions) === WAVES * PER - 1, "position 覆盖 0..N-1 连续区间");

console.log("— 追加后继续导入：position 接续不重叠 —");
r = await alice(`/api/documents/${docId}/sentences`, {
  method: "POST",
  body: JSON.stringify({ sentences: [{ text: "one more sentence", tokens: ["one", "more"] }] }),
});
ok(r.status === 200 && r.data.start === WAVES * PER, `续传 start 接续（实际 ${r.data.start}）`);
r = await alice(`/api/documents/${docId}/sentences?limit=200`, {});
const positions2 = r.data.sentences.map((s) => s.position);
ok(r.data.total === WAVES * PER + 1 && new Set(positions2).size === positions2.length, "续传后 position 仍唯一");

console.log("— LLM Base URL 内网地址校验 —");
await alice("/api/settings", {
  method: "POST",
  body: JSON.stringify({ llm_base_url: "https://0x7f000001/v1", llm_api_key: "sk-test" }),
});
r = await alice("/api/llm/translate", { method: "POST", body: JSON.stringify({ text: "hello" }) });
ok(r.status === 400, "十六进制内网地址 0x7f000001 → 400 拒绝");
for (const bad of ["https://127.1/v1", "https://[::1]/v1", "https://metadata.google.internal/v1", "http://api.openai.com/v1"]) {
  await alice("/api/settings", { method: "POST", body: JSON.stringify({ llm_base_url: bad }) });
  r = await alice("/api/llm/translate", { method: "POST", body: JSON.stringify({ text: "hello" }) });
  ok(r.status === 400, `${bad} → 400 拒绝`);
}
await alice("/api/settings", { method: "POST", body: JSON.stringify({ llm_base_url: "https://203.0.113.10/v1" }) });
r = await alice("/api/llm/translate", { method: "POST", body: JSON.stringify({ text: "hello" }) });
ok(r.status === 502, "公网 IP 不被误拦（连接失败 → 502）");

console.log("— mineru/upload 未配置 Token 拒绝 —");
r = await alice(`/api/mineru/upload?url=${encodeURIComponent("https://foo.aliyuncs.com/x")}`, {
  method: "POST",
  headers: { "Content-Type": "application/pdf" },
  body: "fake",
});
ok(r.status === 400, "未配置 Token → 400（不再当通用 PUT 中继）");

console.log(`\n${passed} 项全部通过` + (process.exitCode ? "（存在失败）" : ""));
