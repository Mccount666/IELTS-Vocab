// 第二十二轮定向冒烟：
//   1) CSP 加固——script-src 不再含 'unsafe-inline'，改放行内联主题脚本的 sha256 hash；
//      且 hash 与 index.html 里实际脚本字节自洽（改了脚本忘改 hash 会被这里抓出来）
//   2) 静态资源可达、sw 已升到 v17
//   3) r21 类型门回归：documents filename / wordbook restore 的对象字段仍被后端拒绝/丢弃
// 用法：先起 `npx wrangler dev --port 8788 --persist-to .tmp-r22-state`（全新库先灌 schema.sql），再 node 本脚本
import { DatabaseSync } from "node:sqlite";

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
    return { status: resp.status, data, resp };
  };
}

const suffix = Date.now().toString(36).slice(-5);

console.log("— CSP 加固 —");
const page = await fetch(BASE + "/");
const html = await page.text();
const csp = page.headers.get("content-security-policy") || "";
ok(csp.includes("script-src") && !csp.split("style-src")[0].includes("'unsafe-inline'"), "script-src 不含 'unsafe-inline'");
ok(/'sha256-[^']+'/.test(csp), "script-src 含 sha256 hash");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
ok(Boolean(m), "index.html 存在内联主题脚本");
if (m) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m[1]));
  const b64 = Buffer.from(new Uint8Array(digest)).toString("base64");
  ok(csp.includes(`'sha256-${b64}'`), "CSP hash 与内联脚本实际字节自洽");
}
ok(csp.includes("https://cdn.jsdelivr.net"), "jsdelivr 仍放行（pdf.js / mammoth / fflate 动态加载）");
// style 属性（进度条宽度等内联样式）仍需 style-src 'unsafe-inline'
ok((csp.match(/style-src[^;]*/) || [""])[0].includes("'unsafe-inline'"), "style-src 保留 'unsafe-inline'");

console.log("— 静态资源与 SW 版本 —");
const sw = await fetch(BASE + "/sw.js");
const swText = await sw.text();
ok(sw.status === 200 && /VERSION = "v\d+"/.test(swText), "sw.js 存在版本号（当前版本由当轮冒烟断言）");
ok((await fetch(BASE + "/js/app.js")).status === 200, "/js/app.js 可达");
ok((await fetch(BASE + "/js/pipeline.js")).status === 200, "/js/pipeline.js 可达");
const appJs = await (await fetch(BASE + "/js/app.js")).text();
// 恢复路径已改为 typeof 类型门（其他位置的 String() 是展示层合理用法，不动）
ok(appJs.includes("filename: d.filename.trim().slice(0, 255)"), "恢复路径 filename 走类型门后的直取");
ok(!appJs.includes("String(s.text).trim()"), "恢复路径不再 String() 强转句子 text");
ok(appJs.includes("word: w.word.trim().toLowerCase().slice(0, 64)"), "恢复路径 word 走类型门后的直取");
ok(appJs.includes('typeof w.translation === "string" ? w.translation : ""'), "恢复路径 translation 只收字符串");

console.log("— r21 类型门回归（后端口径不变） —");
const member = jarClient();
let r = await member("/api/auth/register", { method: "POST", body: JSON.stringify({ username: `r22_member_${suffix}`, password: "secret1" }) });
ok(r.status === 200, "注册成功");

r = await member("/api/documents", { method: "POST", body: JSON.stringify({ filename: { evil: 1 } }) });
ok(r.status === 400, "documents filename 传对象 → 400");

r = await member("/api/wordbook/restore", {
  method: "POST",
  body: JSON.stringify({
    words: [
      { word: { o: 1 }, translation: "x" },
      { word: "restoreok22", translation: "正常" },
    ],
  }),
});
ok(r.status === 200 && r.data.restored === 1, "restore 对象 word 行被丢弃、正常行恢复 1 条");

r = await member("/api/wordbook");
ok(!(r.data.words || []).some((w) => String(w.word).includes("object")), "生词本无 [object object] 垃圾行");

console.log(`\nr22 冒烟：${passed} 项全部通过`);
