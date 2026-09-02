# 真题词库 · 微信小程序版

这是 `ielts_vocab_app` 的微信小程序 MVP 版本，走微信云开发 / CloudBase 原生能力：

- 小程序端：WXML / WXSS / JS
- 用户身份：微信 `OPENID`，无需用户名密码注册登录
- 后端：CloudBase 云函数 `api`
- 数据：CloudBase 云数据库集合
- 第一版范围：粘贴文本导入、查词例句、生词本、复习 SRS、学习统计、基础设置

## 目录

```text
miniprogram/
├── app.js / app.json / app.wxss
├── pages/
│   ├── home/       # 首页与学习概览
│   ├── search/     # 查词、联想、例句、收录
│   ├── import/     # 粘贴文本导入
│   ├── wordbook/   # 生词本与到期筛选
│   ├── review/     # 到期复习、例句填空、评分
│   ├── stats/      # 30 天学习统计
│   └── settings/   # 我的、Key 设置
├── utils/
│   ├── api.js      # wx.cloud.callFunction 封装
│   ├── pipeline.js # 分句、分词、词形还原、索引载荷
│   ├── srs.js      # SRS 调度规则
│   └── format.js   # UI 工具
└── cloudfunctions/
    └── api/        # CloudBase 云函数 API
```

## 需要替换的配置

当前骨架中有两个占位值：

1. `project.config.json`
   - 把 `YOUR_WECHAT_MINIPROGRAM_APPID` 替换成真实微信小程序 AppID。
2. `app.js`
   - 把 `YOUR_CLOUDBASE_ENV_ID` 替换成真实 CloudBase EnvId。

替换后用微信开发者工具打开 `miniprogram/` 目录。

## CloudBase 数据集合

需要在 CloudBase 云数据库中创建这些集合：

- `users`
- `documents`
- `sentences`
- `word_index`
- `wordbook`
- `review_log`
- `user_settings`
- `site_settings`
- `dictionary_cache`

第一版所有核心业务操作统一走云函数 `api`，云函数会用 `cloud.getWXContext()` 读取 `OPENID`，不要相信客户端传来的用户身份。

## 云函数部署

在微信开发者工具中：

1. 打开 `miniprogram/` 项目；
2. 确认云开发环境已选择正确 EnvId；
3. 右键 `cloudfunctions/api`；
4. 选择“上传并部署：云端安装依赖”。

云函数依赖在 `cloudfunctions/api/package.json`：

```json
{
  "dependencies": {
    "wx-server-sdk": "latest"
  }
}
```

## MVP 使用流程

1. 打开首页，首次进入会自动初始化用户；
2. 到“导入”页粘贴真题文本并建立索引；
3. 到“查词”页输入单词，查看来自导入文本的例句；
4. 点击“收录”或“收录例句”加入生词本；
5. 到“生词本”查看到期词；
6. 进入复习页，按“忘记 / 模糊 / 认识”评分；
7. 到“学习统计”查看 30 天复习记录。

## 第一版暂缓功能

- PDF / DOCX 小程序端解析
- MinerU OCR 完整流程
- Web Speech 朗读
- CSV / Anki 导出
- Web 版账号数据迁移
- PWA / Electron 相关能力

这些功能仍保留在 Web 版，后续可以按小程序限制逐步迁移。
