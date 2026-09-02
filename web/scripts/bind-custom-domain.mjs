// 一键把 Worker 绑定到自定义域名（Cloudflare Workers Custom Domains）
// 用法：node scripts/bind-custom-domain.mjs <hostname>  例如 node scripts/bind-custom-domain.mjs vocab.mccou.net
//
// 前提：域名已添加到本 Cloudflare 账号（dashboard → Add a site，按提示到注册商改 NS）。
// 脚本会：找 zone → 自动创建 DNS 记录与证书 → 把 hostname 挂到 wrangler.jsonc 里的 worker。
// 鉴权：复用 `wrangler login` 存下的 OAuth token（无需额外创建 API Token）。

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const hostname = process.argv[2];
if (!hostname || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostname.trim())) {
  console.error('用法：node scripts/bind-custom-domain.mjs <hostname>   例如 vocab.mccou.net');
  process.exit(1);
}

// --- 读 wrangler login 的 OAuth token ---
const wranglerConfigCandidates = [
  join(homedir(), "AppData", "Roaming", "xdg.config", ".wrangler", "config", "default.toml"), // Windows 常见位置
  join(homedir(), ".wrangler", "config", "default.toml"),
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), ".wrangler", "config", "default.toml"),
];
let token = process.env.CLOUDFLARE_API_TOKEN || "";
if (!token) {
  const cfgFile = wranglerConfigCandidates.find((p) => existsSync(p));
  if (cfgFile) {
    const m = readFileSync(cfgFile, "utf8").match(/oauth_token\s*=\s*"([^"]+)"/);
    if (m) token = m[1];
  }
}
if (!token) {
  console.error("找不到 Cloudflare 凭证：先 `npx wrangler login`，或设置 CLOUDFLARE_API_TOKEN 环境变量。");
  process.exit(1);
}

const api = async (path, init = {}) => {
  const resp = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await resp.json();
  if (!data.success) {
    console.error(`API 失败：${path}\n`, JSON.stringify(data.errors, null, 2));
    process.exit(1);
  }
  return data.result;
};

// --- worker 名字取自 wrangler.jsonc（容忍注释） ---
const wranglerRaw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const workerName = JSON.parse(wranglerRaw.replace(/^\s*\/\/.*$/gm, "")).name;

const root = hostname.trim().toLowerCase().split(".").slice(-2).join(".");
const zones = await api(`/zones?name=${encodeURIComponent(root)}`);
if (!zones.length) {
  console.error(
    `账号里没有域名「${root}」的 zone。\n` +
      `请先到 Cloudflare 控制台 Add a site 添加该域名，并按提示到注册商处把 NS 指向 Cloudflare，再重跑本脚本。`
  );
  process.exit(1);
}
const zone = zones[0];
console.log(`zone: ${zone.name}（${zone.status}）`);
console.log(`worker: ${workerName}`);
console.log(`绑定 hostname: ${hostname.trim().toLowerCase()}`);

await api(`/accounts/${zone.account.id}/workers/domains`, {
  method: "PUT",
  body: JSON.stringify({
    zone_id: zone.id,
    hostname: hostname.trim().toLowerCase(),
    service: workerName,
    environment: "production",
  }),
});

console.log("\n✓ 绑定成功！证书签发约需 1-2 分钟，之后直接访问：");
console.log(`  https://${hostname.trim().toLowerCase()}`);
console.log("\n收尾建议：");
console.log(`  1. web/desktop/config.json 的 siteUrl 改成 https://${hostname.trim().toLowerCase()} 后重新 npm run dist 打包桌面壳；`);
console.log("  2. workers.dev 域名若不想继续暴露，可在 dashboard → Workers → ielts-vocab → Domains & Routes 里 Disable。");
