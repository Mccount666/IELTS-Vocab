// 第十七轮定向冒烟：首个注册站长原子判定（并发注册只出一个站长）、
// wordbook POST 的 sentence_id 非法值降级（NaN 不再打穿成 500）。
// 用法：先起 `npx wrangler dev --port 8788 --persist-to .tmp-r17-state`（全新 schema 库），再 node 本脚本
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

console.log("— 并发注册：只产生一个站长 —");
const suffix = Date.now().toString(36).slice(-5);
const clients = ["u1", "u2", "u3"].map(() => jarClient());
const regResults = await Promise.all(
  clients.map((c, n) =>
    c("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: `r17_u${n + 1}_${suffix}`, password: "secret1" }),
    })
  )
);
ok(regResults.every((r) => r.status === 200), "3 个并发注册全部成功");
const adminCount = regResults.filter((r) => r.data.user?.is_admin).length;
ok(adminCount === 1, `is_admin=1 的恰好 1 人（实际 ${adminCount}）`);

// 站长视角核对：用任一非站长登录后 settings 不该显示站长卡片；
// 直接用站长身份查 /api/settings 的 users_count 应为 3
let r;
const adminIdx = regResults.findIndex((r) => r.data.user?.is_admin);
r = await clients[adminIdx]("/api/settings");
ok(r.status === 200 && r.data.is_admin === true && r.data.users_count === 3, `站长可见 users_count=3（实际 ${r.data?.users_count}）`);
const nonAdminIdx = (adminIdx + 1) % 3;
r = await clients[nonAdminIdx]("/api/settings");
ok(r.data.is_admin === false, "并发注册的另一人不是站长");

console.log("— sentence_id 非法值降级 —");
const bob = clients[nonAdminIdx];
r = await bob("/api/documents", { method: "POST", body: JSON.stringify({ filename: "r17 doc", exam_type: "IELTS" }) });
const docId = r.data.id;
r = await bob(`/api/documents/${docId}/sentences`, {
  method: "POST",
  body: JSON.stringify({ sentences: [{ text: "hello world sentence", tokens: ["hello", "world"] }] }),
});
ok(r.status === 200, "准备一个例句");
r = await bob("/api/wordbook", {
  method: "POST",
  body: JSON.stringify({ word: "r17nan", sentence_id: "abc" }),
});
ok(r.status === 200 && r.data.ok === true, 'sentence_id="abc" → 200 且正常收录（不再 500）');
r = await bob("/api/wordbook", {
  method: "POST",
  body: JSON.stringify({ word: "r17valid", sentence_id: 999999 }),
});
ok(r.status === 200 && r.data.ok === true, "不存在但格式合法的 sentence_id → 200（归属校验降级为无例句）");
r = await bob("/api/wordbook");
const nanEntry = (r.data.words || []).find((w) => w.word === "r17nan");
ok(nanEntry && nanEntry.sentence_id == null, '非法 sentence_id 未挂例句（sentence_id 为空）');

console.log(`\n${passed} 项全部通过` + (process.exitCode ? "（存在失败）" : ""));
