# 自定义域名绑定（解决 workers.dev 在大陆被 DNS 污染的问题）

`ielts-vocab.mccou.workers.dev` 在大陆普遍被污染，用户必须挂代理才能访问。
绑一个自己的域名（Cloudflare 在大陆可达性远好于 workers.dev）即可直连。

## 你需要做的（唯一需要人工的一步）

买一个域名。推荐选择（都支持即时接入 Cloudflare，一年 ¥10-80）：

| 注册商 | 推荐理由 |
| --- | --- |
| Cloudflare Registrar | 成本价、自动接入账号、续费不涨；但需外币卡 |
| Namesilo / Porkbun | 便宜、支持支付宝/PayPal，接入 Cloudflare 也就十分钟 |
| 阿里云/腾讯云 | 有支付宝即可；`.top`/`.xyz` 首年几块钱（续费略贵） |

> 注意：`.cn` 域名解析到 Cloudflare 没有备案问题（Cloudflare 是海外节点），
> 但如果以后想迁到国内 CDN 就需要备案。个人学习站一般无所谓。

## 买好后的接入步骤（全自动）

1. 域名加进 Cloudflare 账号：Dashboard → **Add a site** → 输入域名 → Free 计划
   → 按页面提示到注册商处把 Nameservers 改成 Cloudflare 给的两条。生效几分钟到几小时。
2. 回到本机跑一条命令（`wrangler login` 的凭证会被脚本自动复用）：

   ```bash
   cd web
   node scripts/bind-custom-domain.mjs vocab.你的域名.com
   ```

   脚本会自动：找到 zone → 创建 DNS 记录和证书 → 把 hostname 挂到 worker `ielts-vocab`。
3. 等 1-2 分钟证书签发，浏览器直连 `https://vocab.你的域名.com` 即可。
4. 收尾：
   - `web/desktop/config.json` 的 `siteUrl` 改成新域名，`npm run dist` 重打桌面安装包；
   - 不想保留 workers.dev 入口的话，Dashboard → Workers → ielts-vocab → Domains & Routes → Disable。

## 好看的名字建议

- `vocab.`（最直白）· `word.` · `ielts.` · `dict.` · `danci.`（拼音，好记）
- 短 + 好拼 + 好念 > 语义精确；避免连字符和数字。
