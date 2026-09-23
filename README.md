# IELTS-Vocab · 真题词库

**查一个单词 → 看到它在你自己导入的真题里出现过的所有句子。**

一个项目的三种形态，核心数据结构同构（documents / sentences / words / word_sentences 倒排索引），文本分句/分词/词形还原逻辑在三种实现间逐行为对齐：

| 形态 | 目录 | 技术栈 | 状态 |
| --- | --- | --- | --- |
| 桌面版（单机） | 仓库根目录 `*.py` | Python + PySide6 + 本地 SQLite | 可用 |
| Web 版（多用户） | `web/` | Cloudflare Workers + D1 + 原生 HTML/CSS/JS（PWA + Electron 壳） | 已上线，五轮迭代 |
| 微信小程序版 | `miniprogram/` | 微信云开发 CloudBase（云函数 + 云数据库）+ 原生 WXML/WXSS | MVP 已部署 |

## 核心功能

- **导入真题**：PDF / DOCX / TXT / MD / 粘贴文本 → 分句 → 分词 → 建倒排索引
- **查词**：词形还原兜底（搜 run 命中 running）、短语、考试类型筛选、真题词表联想、上下文展开
- **生词本**：一键收藏（可带真题例句）、熟悉度、筛选排序、批量管理
- **复习**：SRS 到期调度（忘记/模糊/认识 → 间隔逐级拉长）、例句填空模式、学习统计与连续打卡

## 快速开始

### Web 版（Cloudflare，免费额度即可）

```bash
cd web
npm install
npx wrangler login
npx wrangler d1 create ielts_vocab   # 把 database_id 填进 wrangler.jsonc
npm run db:migrate:remote
npm run deploy
```

详见 [web/README.md](web/README.md)。

### 微信小程序版（CloudBase）

1. 用微信开发者工具导入 `miniprogram/` 目录；
2. 替换 `project.config.json` 的 AppID 与 `app.js` 的 EnvId；
3. 在云开发控制台创建集合：`users / documents / sentences / word_index / wordbook / review_log / user_settings / site_settings / dictionary_cache`；
4. 上传部署云函数 `cloudfunctions/api`（云端安装依赖）。

详见 [miniprogram/README.md](miniprogram/README.md)。

### 桌面版（Python）

```bash
pip install -r requirements.txt
python main.py
```

## 安全模型

- Web 版：用户名密码 + PBKDF2 + HttpOnly Session Cookie，数据按 user_id 隔离，LLM/MinerU Key 存库不下发浏览器；
- 小程序版：微信 OPENID 免登录，所有业务走云函数校验 `_openid` 归属，管理员身份固定钉在 `site_settings.adminOpenid`；
- 两个后端各自独立，互不影响。

## Contributors

- [Mccount666](https://github.com/Mccount666) — 项目作者
- [Claude](https://claude.ai) — AI 辅助开发

## License

个人学习项目，仅供参考。
