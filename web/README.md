# 真题词库 · Web 版（Cloudflare）

桌面版（PySide6）的 Web 化重构：**查一个单词 → 看到它在你自己导入的真题里出现过的所有句子**。

多用户版（2026-09-02）：**注册登录、数据按账号隔离、LLM/MinerU Key 每人自己填**；配 Electron 桌面壳可打包成 Windows 安装包分发（`desktop/`）。

- **一套部署**：Worker（API）+ 静态前端（`public/`）+ D1 数据库（SQLite），`wrangler deploy` 一次完成
- **零构建**：前端为原生 HTML/CSS/JS，无需 npm build
- **免费额度友好**：分句/分词/文件解析全部在浏览器完成，Worker 只做 SQL

## 功能

| 模块 | 能力 |
| --- | --- |
| 查词 | 输入即搜（防抖）+ 回车；**真题词表实时联想**（↑↓ 选择、回车查、显示出现句数，遵循考试筛选）；单词 & 短语（`look forward to`）；词形还原兜底（搜 run 命中 running）；按考试类型筛选；目标词及其词形变体高亮；**双击句中单词直接查它**；查不到例句时推荐真题里的相近词；上下文 ±2 句展开；例句一键复制；单词/例句朗读（浏览器 TTS）；AI 释义与例句翻译（可选 LLM）；`/` 或 `Ctrl/Cmd+K` 聚焦搜索；最近搜索历史；已在生词本的词直接显示「✓ 已在生词本 / 已收录」 |
| 导入 | PDF / DOCX / TXT / MD，拖拽或多选批量；粘贴文本直接导入；考试类型标记；扫描版 PDF 自动 MinerU OCR；分块建索引带进度 |
| 生词本 | 一键收藏（可带真题例句）；例句页「收录」把单词连同例句一起收进；顶部统计条（总数/生疏/熟练/今日已复习）；熟悉度筛选 chips（全部/生疏/一般/熟练，带计数）+ 排序（时间/熟悉度/字母）+ 文本筛选；**SRS 到期调度**（认识→间隔逐级拉长 2/4/8/16/32 天，忘记/模糊→明天再见；生词本 tab 徽标显示今日到期数，复习范围可选「到期词」）；**批量管理**（勾选/全选后批量删除或批量设置熟悉度）；**复习模式**（全屏闪卡：忘记/模糊/认识 → 熟悉度 0-5，空格显示答案、1/2/3 评分，越不熟越先出；可选只复习到期词/生疏词；**例句填空模式**：挖空目标词看句回想，翻面高亮答案；结束后可一键再来一轮）；导出 CSV / Anki；**中文反查**（直接输入中文释义找真题例句，顶部给候选词 chips）；**看义忆词模式**（释义先行、翻面出词） |
| 学习统计 | 生词本页顶部卡片：连续打卡天数、今日待复习/已复习、累计复习次数、最近 15 周复习热力图（按客户端本地日期记档） |
| 外观 | 暗色 / 亮色 / 跟随系统三态主题（顶栏一键切换，自动记忆）；PWA 可安装到手机/桌面（manifest + Service Worker，静态资源秒开、断网可见壳）；tab 页记忆（刷新后停留原页） |
| 设置 | LLM、MinerU API Key 配置（存 D1，不下发浏览器）；注册码保护与注册人数（站长）；JSON 全量备份与**一键恢复**（合并式，保留熟悉度与收藏时间，例句引用自动重连）；**每日复习提醒**（Web Push，每天 9:00 给有到期词的浏览器推通知，订阅绑定账号+浏览器，登出自动解除） |
| 数据 | 与桌面版同构的 4 张核心表（documents / sentences / words / word_sentences），倒排索引一致 |

## 本地开发

```bash
cd web
npm install
npm run db:migrate:local   # 初始化本地 D1
npm run dev                # http://127.0.0.1:8787
npm test                   # 文本管线单测（与桌面版 Python 行为对齐）
```

## 部署到 Cloudflare

> 前置：一个 Cloudflare 账号（免费版即可），Node 18+。

```bash
cd web
npm install
npx wrangler login

# 1) 创建 D1 数据库，把输出的 database_id 填进 wrangler.jsonc
npx wrangler d1 create ielts_vocab

# 2) 初始化远端表结构
npm run db:migrate:remote

# 3) 部署（Worker + 前端静态资源一次完成）
npm run deploy
```

部署完成后会得到 `https://ielts-vocab.<你的子域>.workers.dev`，浏览器打开即可用。

### 多用户与账号

- 打开站点即见登录/注册页；**第一个注册的账号自动成为站长**，并认领多用户改造前的历史数据与已配 Key；
- 之后每个注册用户拥有独立的文档、生词本与设置；LLM / MinerU Key 存在自己的账号里，明文永不下发浏览器，接口只回打码值；
- 登录态为 30 天有效的 HttpOnly session cookie；
- **站长**可在「设置 → 站点管理」设置**注册码**：开启后新用户注册必须填码，防止陌生人滥用共享的免费额度（输入 `-` 清除）；
- 「数据」卡片的全量备份只包含当前用户自己的数据。

### 桌面版（Electron 壳）

```bash
cd web/desktop
npm install
npm start        # 连云端站点开一个独立窗口（登录态/缓存本地持久化）
npm run dist     # 打包 Windows 安装包 + 便携版 → release/
```

- 站点地址在 `desktop/config.json` 的 `siteUrl`，分发前改成正式域名重新打包即可；
- ⚠️ `*.workers.dev` 在中国大陆被 DNS 污染，无代理用户打不开——**分发给他人前务必绑定自有域名**，见 [docs/CUSTOM-DOMAIN.md](docs/CUSTOM-DOMAIN.md)：买好域名加进 Cloudflare 后跑一条命令即可自动完成 DNS + 证书 + 绑定：

  ```bash
  node scripts/bind-custom-domain.mjs vocab.你的域名.com
  ```

### 旧库迁移（多用户改造前部署过的库）

```bash
npm run db:migrate:multiuser   # 执行 migrations/001-multiuser.sql（一次性、原子）
# 002 起的增量迁移按编号顺序执行（此前部署过的库缺哪个补哪个）：
for f in migrations/0{02,03,04,05,06,07,08,09,10,11}-*.sql; do npx wrangler d1 execute ielts_vocab --remote --file="$f"; done
# 011（推送订阅）之外还需要配置 VAPID 私钥才能发提醒：
npx wrangler secret put VAPID_PRIVATE_KEY   # 值为 P-256 PKCS8 的 base64（公钥已在 wrangler.jsonc vars）
```

全新部署无需此步（`db:migrate:remote` 用的 schema.sql 已是最新形态）。

也可以用 Cloudflare MCP 让 agent 直接执行上述 `d1 create / execute / deploy` 命令。

## 项目结构

```
web/
├── wrangler.jsonc          # Cloudflare 配置（D1 绑定 + 静态资源）
├── schema.sql              # D1 表结构（与桌面版兼容 + Web 新增表，最新形态）
├── migrations/             # 已部署旧库的增量迁移（001 多用户 … 011 推送订阅，按编号顺序执行）
├── scripts/
│   ├── bind-custom-domain.mjs  # 自定义域名一键绑定（详见 docs/CUSTOM-DOMAIN.md）
│   └── gen-icons.mjs           # 重新生成 PWA 图标（node scripts/gen-icons.mjs）
├── src/
│   ├── worker.js           # API 路由 + D1 数据层
│   ├── auth.js             # 注册/登录/会话（PBKDF2 + HttpOnly cookie）
│   ├── integrations.js     # LLM / MinerU / 在线词典 —— 第三方端点全在这里
│   └── lemmatize.js        # 词形还原（与桌面版 text_processor 一致）
├── public/                 # 前端静态资源（由 Worker 同域托管）
│   ├── index.html
│   ├── style.css           # 主题变量化：亮/暗两套（:root[data-theme="dark"]）
│   ├── manifest.json       # PWA 清单
│   ├── sw.js               # Service Worker：/api 直连，页面 network-first，静态 SWR
│   ├── icon-*.png          # 应用图标（192 / 512 / maskable）
│   └── js/
│       ├── app.js          # 界面逻辑（查词/导入/生词本/复习/主题/设置）
│       └── pipeline.js     # 浏览器端分句/分词/建索引载荷 + PDF/DOCX 解析 + MinerU 解压
├── test/pipeline.test.mjs  # 与 Python 版输出逐例对齐的单测
└── docs/                   # INTEGRATIONS.md（第三方接口）· CUSTOM-DOMAIN.md（域名绑定）
```

## 测试与验收

```bash
npm test                     # 文本管线单测（与桌面版 Python 输出逐例对齐）
bash test/run-regression-r21.sh   # 旧冒烟回归循环（r8/r17-r20，各自全新库逐个跑）

# 单轮定向冒烟（先起全新库的 dev server，再跑对应脚本；r26 需 --test-scheduled）：
npx wrangler d1 execute ielts_vocab --local --persist-to .tmp-state --file=schema.sql
npx wrangler dev --port 8788 --test-scheduled --persist-to .tmp-state &
node test/api-smoke-r21.mjs .tmp-state   # r21-r28 各有定向冒烟：test/api-smoke-r*.mjs
```

- `test/api-smoke-r5.mjs` 起为全链路 30 断言，其后每轮迭代各带定向冒烟（r17 并发注册/r18 配额/r19 索引与孤儿词/r20 词典所有权/r21 类型门/r22 CSP hash 自洽/r23 失败锁定+流式导出/r24 覆盖索引/r25 LLM 上限/r26 推送订阅/r27 提醒到期过滤/r28 订阅生命周期）。
- 冒烟断言首注册即站长、各轮要求全新库——共用库必假失败，回归循环脚本已处理。
- 无头浏览器快验（不依赖 Playwright）：`msedge --headless=new --dump-dom http://127.0.0.1:8788/`——`data-theme` 属性出现即 CSP hash 未拦内联脚本，chips 渲染即 ES module 正常执行。

## 与桌面版的关系

桌面版（仓库根目录的 `*.py`）继续可用，两者数据结构同构：

| | 桌面版 | Web 版 |
| --- | --- | --- |
| 存储 | 本地 SQLite（data/vocab.db） | Cloudflare D1 |
| 解析 | PyMuPDF / python-docx | 浏览器 PDF.js / mammoth.js |
| 词典 | ECDICT 离线 → dictionaryapi.dev | D1 缓存 → dictionaryapi.dev →（可选）LLM |
| OCR | — | MinerU（可选） |
| 生词本 | — | ✔（Web 新增） |
