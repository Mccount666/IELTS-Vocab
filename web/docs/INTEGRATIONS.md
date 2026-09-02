# 外部集成接口文档（LLM / MinerU）

本项目所有第三方能力都集中在两个位置：

| 能力 | 架构位置 | 说明 |
| --- | --- | --- |
| LLM 词典增强 | `src/integrations.js` → `llmDefine / llmTranslate / llmChat`；Worker 路由 `/api/llm/*`；Key 存 D1 `settings` 表（`llm_api_key / llm_base_url / llm_model`） | 任意 OpenAI 兼容接口 |
| MinerU OCR | `src/integrations.js` → `mineruRequestUploadUrls / mineruBatchResult / isMineruDownloadUrlAllowed`；Worker 路由 `/api/mineru/*`；Token 存 D1 `settings` 表（`mineru_api_token`） | 扫描版 PDF 文字识别 |

**Key 的存放方式**：浏览器「设置」页提交 → Worker 写入 D1 `settings` 表 → 调用时 Worker 从 D1 读取并在服务端转发请求。Key 永不下发到浏览器（`GET /api/settings` 只返回打码值，如 `sk-••••abcd`），前端也不落 localStorage。

---

## 1. LLM（OpenAI 兼容接口）

### 1.1 配置项（设置页）

| 设置键 | 默认值 | 说明 |
| --- | --- | --- |
| `llm_base_url` | `https://api.openai.com/v1` | 任何 OpenAI 兼容服务均可，如 `https://api.deepseek.com/v1` |
| `llm_api_key` | — | 对应服务的 API Key |
| `llm_model` | `gpt-4o-mini` | 如 `deepseek-chat`、`moonshot-v1-8k` 等 |

### 1.2 Worker → LLM 的实际出站请求

```http
POST {llm_base_url}/chat/completions
Authorization: Bearer {llm_api_key}
Content-Type: application/json

{
  "model": "{llm_model}",
  "temperature": 0.2,
  "response_format": { "type": "json_object" },   // 仅 llmDefine 使用
  "messages": [ ... ]
}
```

超时 60s。非 200 响应会以 `LLM API 返回 {status}: {body前300字}` 报给前端。

### 1.3 平台对外暴露的接口（前端调用）

#### `POST /api/llm/define` —— 生成词典条目（中文释义 + 英文释义 + 双语例句）

```jsonc
// 请求
{ "word": "abandon" }

// 响应（成功后自动写入 dictionary_cache，下次同词免调用）
{
  "definition": {
    "word": "abandon",
    "phonetic": "/əˈbændən/",
    "translation": "v. 放弃，抛弃；n. 放纵",
    "definition": "to leave somebody/something completely; to give up completely",
    "examples": [{ "en": "...", "zh": "..." }],
    "source": "LLM（gpt-4o-mini）"
  }
}
```

LLM 的系统提示词固定为「英汉词典编辑，只输出 JSON」，解析做了三层兜底（直接 parse → 剥 ```json 代码块 → 提取最外层 `{...}`）。

#### `POST /api/llm/translate` —— 例句翻译

```jsonc
// 请求
{ "text": "The deforestation has accelerated over the past decade." }
// 响应
{ "zh": "过去十年里，森林砍伐不断加速。" }
```

### 1.4 扩展点

需要接新 LLM 功能时：在 `integrations.js` 加一个 `llmChat(settings, messages)` 的封装函数，在 `worker.js` 加一条路由即可，鉴权（访问码）、Key 读取、错误处理都是现成的。

---

## 2. MinerU OCR（扫描版 PDF）

### 2.1 配置项

| 设置键 | 来源 |
| --- | --- |
| `mineru_api_token` | mineru.net 注册 → 控制台「API 申请」页生成的 Token（Bearer） |

### 2.2 调用时序（全部经 Worker 代理，浏览器不直连 MinerU，规避 CORS）

```
浏览器                     Worker                          MinerU
  │ POST /api/mineru/upload-urls ──► POST /file-urls/batch ──►│
  │ ◄── { batchId, fileUrls } ◄──── { batch_id, file_urls } ──│
  │ POST /api/mineru/upload?url=<fileUrls[0]>                  │
  │        （PDF 原始字节流）      ──► PUT <预签名地址> ───────►│
  │ 每 5s: GET /api/mineru/batch/:id ─► GET /extract-results/batch/{batch_id}
  │ ◄── state: waiting-file → running → done(full_zip_url)     │
  │ GET /api/mineru/download?url=<full_zip_url> ─► 下载 zip ──►│
  │ 浏览器端 fflate 解压取 .md 全文（pipeline.js unzipMarkdown）│
```

### 2.3 使用的 MinerU 端点（集中在 `src/integrations.js` 顶部 `MINERU_BASE`）

> ⚠️ MinerU 托管 API 的完整文档在 mineru.net 控制台内（登录后可见）。以下按公开的 v4 接口形态实现；
> **若官方字段有出入，只需改 `integrations.js` 里对应的三个函数**，Worker 路由与前端流程不受影响。

| 步骤 | 端点 | 请求要点 |
| --- | --- | --- |
| 申请上传地址 | `POST https://mineru.net/api/v4/file-urls/batch` | Header `Authorization: Bearer {token}`；body `{ "enable_formula": true, "enable_table": true, "files": [{ "name": "x.pdf", "is_ocr": true }] }`；返回 `{ code: 0, data: { batch_id, file_urls: [...] } }` |
| 上传文件 | `PUT {file_urls[i]}` | 预签名地址，无需鉴权头；`Content-Type: application/pdf` |
| 轮询结果 | `GET https://mineru.net/api/v4/extract-results/batch/{batch_id}` | 每文件项含 `state`（`waiting-file / pending / running / done / failed`）与 `err_msg`；`done` 时提供 `full_zip_url`（zip 内含 `.md` 全文） |
| 下载结果 | `GET {full_zip_url}` | 经 `/api/mineru/download` 代理；域名白名单：`mineru.net / openxlab.org.cn / aliyuncs.com` |

### 2.4 前端触发逻辑（`public/js/app.js`）

- 导入页勾选「扫描版 PDF 自动用 MinerU OCR」且已配置 Token → PDF 直接走 OCR 流程；
- 未勾选时：若某 PDF 平均每页文本 < 150 字符（`pipeline.js looksLikeScanned`）且已配置 Token → 自动转 OCR；
- 解析超时上限 8 分钟，每 5 秒轮询一次。

### 2.5 扩展点

若之后想接其它 OCR（如 Mathpix、PaddleOCR 自建服务），在 `integrations.js` 新增一个适配函数对，再在 `app.js` 的 `mineruExtract()` 旁加一个分支即可，导入管线（分句 → 建索引）完全复用。
