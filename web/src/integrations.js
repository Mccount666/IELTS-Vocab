// 外部集成适配层：在线词典 / LLM（OpenAI 兼容）/ MinerU OCR。
// 所有第三方端点集中在这一个文件里，换供应商或改端点只动这里。
// 详细接口约定见 docs/INTEGRATIONS.md。

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// 在线词典兜底（dictionaryapi.dev，免费英文释义；中文释义交给 LLM）
// ---------------------------------------------------------------------------

const DICTIONARY_API = "https://api.dictionaryapi.dev/api/v2/entries/en";

export async function lookupOnline(word) {
  try {
    const resp = await fetch(`${DICTIONARY_API}/${encodeURIComponent(word.toLowerCase())}`, {
      headers: { "User-Agent": "IELTS-Vocab-Web" },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data) || !data.length) return null;
    const entry = data[0];
    const phonetic =
      (typeof entry.phonetic === "string" && entry.phonetic) ||
      (entry.phonetics || []).find((p) => p.text)?.text ||
      "";
    const meanings = (entry.meanings || []).map((m) => {
      const defs = (m.definitions || []).map((d) => d.definition || "");
      return `[${m.partOfSpeech || ""}] ${defs.join("; ")}`;
    });
    return {
      word,
      phonetic,
      translation: "",
      definition: meanings.join("\n"),
      examples: [],
      source: "Online API",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LLM：任意 OpenAI 兼容接口（OpenAI / DeepSeek / Kimi / 本地中转均可）
// 设置项：llm_base_url（默认 https://api.openai.com/v1）、llm_api_key、llm_model
// ---------------------------------------------------------------------------

export function llmDefaults(settings) {
  const baseUrl = (settings.llm_base_url || "https://api.openai.com/v1").replace(/\/+$/, "");
  // 只允许 https 且拒绝内网/云元数据地址，防止把 Worker 当 SSRF 跳板
  if (!/^https:\/\/(?!localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?)/i.test(baseUrl)) {
    throw new HttpError(400, "LLM Base URL 必须是 https:// 开头的公网地址");
  }
  return {
    baseUrl,
    apiKey: settings.llm_api_key || "",
    model: settings.llm_model || "gpt-4o-mini",
  };
}

async function llmChat(settings, messages, jsonMode = false) {
  const { baseUrl, apiKey, model } = llmDefaults(settings);
  if (!apiKey) throw new HttpError(400, "尚未配置 LLM API Key，请到「设置」页填写");
  const body = { model, temperature: 0.2, messages };
  if (jsonMode) body.response_format = { type: "json_object" };
  let resp;
  try {
    resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new HttpError(502, `无法连接 LLM 服务（${baseUrl}）：${e.message}`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new HttpError(resp.status === 401 ? 401 : 502, `LLM API 返回 ${resp.status}：${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* 继续尝试剥离代码块 */
  }
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    /* 提取最外层花括号 */
  }
  const m = stripped.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* 放弃 */
    }
  }
  return null;
}

// 生成词典条目：音标 + 中文释义 + 英文释义 + 双语例句
export async function llmDefine(settings, word) {
  const { model } = llmDefaults(settings);
  const content = await llmChat(
    settings,
    [
      {
        role: "system",
        content: "你是一位严谨的英汉词典编辑。只输出一个 JSON 对象，不要输出任何其他文字。",
      },
      {
        role: "user",
        content:
          `请为英文单词 "${word}" 编写词典条目，输出 JSON，格式：\n` +
          `{"phonetic":"英式音标，形如 /əˈbændən/","translation":"中文释义：词性+含义，多个义项用「；」分隔","definition":"简明英文释义，一到两句","examples":[{"en":"英文例句","zh":"例句中文翻译"}]}\n` +
          `examples 恰好给 2 条，例句要贴近雅思/托福学术或生活语境。`,
      },
    ],
    true
  );
  const parsed = parseJsonLoose(content);
  if (!parsed || !parsed.translation) {
    throw new HttpError(502, `LLM 返回内容无法解析为词典条目：${content.slice(0, 200)}`);
  }
  return {
    word,
    phonetic: parsed.phonetic || "",
    translation: parsed.translation || "",
    definition: parsed.definition || "",
    examples: Array.isArray(parsed.examples) ? parsed.examples.slice(0, 4) : [],
    source: `LLM（${model}）`,
  };
}

// 例句中文翻译
export async function llmTranslate(settings, text) {
  const content = await llmChat(settings, [
    { role: "system", content: "你是专业翻译。把用户发来的英文翻译成自然流畅的简体中文，只输出译文本身，不要任何解释或引号。" },
    { role: "user", content: text.slice(0, 2000) },
  ]);
  return content.trim();
}

// ---------------------------------------------------------------------------
// MinerU OCR（扫描版 PDF 解析，https://mineru.net）
// 设置项：mineru_api_token（在 mineru.net 控制台 → API 申请）
//
// 托管 API 文档在 mineru.net 控制台内（登录后可见）。以下端点按公开的 v4 形态实现：
//   1. POST /file-urls/batch        申请一批预签名上传地址，返回 { batch_id, file_urls[] }
//   2. PUT  file_urls[i]            直接上传文件（无需鉴权头，预签名地址）
//   3. GET  /extract-results/batch/{batch_id}   轮询解析结果
//      每个文件项含 state（waiting-file/pending/running/done/failed）、
//      full_zip_url（done 时提供结果压缩包，内含 .md 全文）
// 如官方字段有出入，只需调整下面三个函数，worker 其余部分不受影响。
// ---------------------------------------------------------------------------

const MINERU_BASE = "https://mineru.net/api/v4";

export async function mineruRequestUploadUrls(token, files) {
  const resp = await fetch(`${MINERU_BASE}/file-urls/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      enable_formula: true,
      enable_table: true,
      files: files.map((f) => ({ name: f.name, is_ocr: true })),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || data.code !== 0) {
    const msg = data?.msg || `HTTP ${resp.status}`;
    throw new HttpError(502, `MinerU 申请上传地址失败：${msg}`);
  }
  return data.data; // { batch_id, file_urls: [...] }
}

export async function mineruBatchResult(token, batchId) {
  const resp = await fetch(`${MINERU_BASE}/extract-results/batch/${encodeURIComponent(batchId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || data.code !== 0) {
    const msg = data?.msg || `HTTP ${resp.status}`;
    throw new HttpError(502, `MinerU 查询解析结果失败：${msg}`);
  }
  return data.data; // { extract_result: [{ file_name, state, full_zip_url, err_msg, ... }] }
}

// MinerU 结果压缩包/文件下载地址白名单校验（防止 worker 被当成通用下载代理）
export function isMineruDownloadUrlAllowed(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return false;
    return /(^|\.)(mineru\.net|openxlab\.org\.cn|aliyuncs\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}
