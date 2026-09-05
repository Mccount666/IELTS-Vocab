// 真题词库 Web 版 · Worker 主入口（多用户版）
// 职责：API 路由 + D1 数据层 + 会话鉴权。文本解析/分句/分词全部在浏览器端完成，
// Worker 只做 SQL 写入与查询，把免费版 CPU 时间降到最低。
// 鉴权模型：注册登录发 HttpOnly session cookie；除 health 与 /api/auth/* 外全部要求登录；
// 所有业务数据按 documents.user_id / wordbook.user_id / user_settings.user_id 隔离。

import { lemmatize } from "./lemmatize.js";
import {
  HttpError,
  lookupOnline,
  llmDefine,
  llmTranslate,
  mineruRequestUploadUrls,
  mineruBatchResult,
  isMineruDownloadUrlAllowed,
} from "./integrations.js";
import {
  hashPassword,
  verifyPassword,
  createSession,
  deleteSession,
  sessionCookie,
  clearSessionCookie,
  getUser,
  requireUser,
} from "./auth.js";

// D1 安全阈值：单条 SQL 最多 100 个绑定参数；batch/IN 查询都按更小的块切
const BATCH_CHUNK = 200; // 每批 INSERT 语句数
const IN_CHUNK = 90; // IN (...) 参数个数
const SENTENCE_LIMIT = 200; // 单次搜索返回例句上限

// 每用户可保存的设置键（Key 明文永不下发浏览器，GET 只回打码值）
const USER_SETTING_KEYS = new Set([
  "llm_base_url",
  "llm_model",
  "llm_api_key",
  "mineru_api_token",
]);

// 登录/注册限速：每 IP 在窗口期内最多 AUTH_RATE_LIMIT 次认证请求（防对站长账号的暴力破解）
const AUTH_RATE_LIMIT = 30;
const AUTH_RATE_WINDOW_MIN = 15;

// 占位密码哈希：登录时对不存在的用户也执行一次等价 PBKDF2，拉平响应时间
// （格式与 auth.js hashPassword 一致：pbkdf2:迭代:16字节盐b64:32字节哈希b64）
const DUMMY_PASSWORD_HASH = `pbkdf2:100000:${"A".repeat(22)}==:${"A".repeat(43)}=`;

// ---------------------------------------------------------------------------

// 统一安全响应头：nosniff 防 MIME 嗅探、禁 iframe 内嵌、限制 Referrer 外泄
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      const resp = await env.ASSETS.fetch(request);
      return new Response(resp.body, { status: resp.status, headers: mergeHeaders(resp.headers, SECURITY_HEADERS) });
    }
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error("Unhandled API error:", err);
      return json({ error: `服务器内部错误：${err.message}` }, 500);
    }
  },
};

function mergeHeaders(base, extra) {
  const h = new Headers(base);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    // no-store：API 响应带会话数据，禁止浏览器/中间层缓存（静态资源走 SW 自己的策略，不受影响）
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers },
  });
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function nowIso() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

// --- 数据层：每用户设置 / 站点设置 ---

async function getUserSettings(env, userId) {
  const rows = await env.DB
    .prepare("SELECT key, value FROM user_settings WHERE user_id = ?")
    .bind(userId)
    .all();
  return Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
}

async function setUserSetting(env, userId, key, value) {
  await env.DB
    .prepare(
      "INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) " +
        "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value"
    )
    .bind(userId, key, value)
    .run();
}

async function getSiteSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : "";
}

async function setSiteSetting(env, key, value) {
  await env.DB
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

// ---------------------------------------------------------------------------

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/health" && method === "GET") {
    return json({ ok: true, time: nowIso() });
  }

  // ---------- 认证（免登录） ----------
  if (pathname === "/api/auth/register" && method === "POST") {
    return register(request, env);
  }
  if (pathname === "/api/auth/login" && method === "POST") {
    return login(request, env);
  }
  if (pathname === "/api/auth/logout" && method === "POST") {
    await deleteSession(request, env);
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
  }
  if (pathname === "/api/auth/me" && method === "GET") {
    const user = await getUser(request, env);
    // 未登录回 200 + user:null，前端启动流程据此切换到登录视图，不算错误
    return json({ user: user ? { id: user.id, username: user.username, is_admin: Boolean(user.is_admin) } : null });
  }

  // ---------- 以下全部要求登录 ----------
  const user = await requireUser(request, env);

  // ---------- 设置（每用户） ----------
  if (pathname === "/api/settings" && method === "GET") {
    const s = await getUserSettings(env, user.id);
    let registration_code_set = false;
    let users_count = 0;
    if (user.is_admin) {
      registration_code_set = Boolean(await getSiteSetting(env, "registration_code"));
      users_count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first())?.n || 0;
    }
    return json({
      llm_base_url: s.llm_base_url || "",
      llm_model: s.llm_model || "",
      llm_key_set: Boolean(s.llm_api_key),
      llm_key_masked: maskSecret(s.llm_api_key),
      mineru_token_set: Boolean(s.mineru_api_token),
      mineru_token_masked: maskSecret(s.mineru_api_token),
      is_admin: Boolean(user.is_admin),
      registration_code_set,
      users_count,
    });
  }

  if (pathname === "/api/settings" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    for (const [key, value] of Object.entries(body)) {
      if (!USER_SETTING_KEYS.has(key)) continue;
      if (typeof value !== "string") continue;
      await setUserSetting(env, user.id, key, value.trim());
    }
    return json({ ok: true });
  }

  // ---------- 站点管理（仅站长） ----------
  if (pathname === "/api/admin/site-settings" && method === "POST") {
    if (!user.is_admin) throw new HttpError(403, "仅站长可修改站点设置");
    const body = await request.json().catch(() => ({}));
    if (typeof body.registration_code === "string") {
      await setSiteSetting(env, "registration_code", body.registration_code.trim());
    }
    return json({ ok: true });
  }

  // ---------- 文档导入 ----------
  if (pathname === "/api/documents" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const filename = String(body.filename || "").trim().slice(0, 255);
    const examType = String(body.exam_type || "Other").trim().slice(0, 32);
    if (!filename) throw new HttpError(400, "缺少 filename");
    const result = await env.DB.prepare(
      "INSERT INTO documents (user_id, filename, exam_type, imported_at) VALUES (?, ?, ?, ?)"
    )
      .bind(user.id, filename, examType, nowIso())
      .run();
    return json({ id: result.meta.last_row_id, sentence_count: 0 });
  }

  let m = pathname.match(/^\/api\/documents\/(\d+)\/sentences$/);
  if (m && method === "POST") {
    const docId = Number(m[1]);
    const body = await request.json().catch(() => ({}));
    const sentences = Array.isArray(body.sentences) ? body.sentences : [];
    if (!sentences.length) return json({ inserted: 0 });
    // 前端按 400 句/请求分块上传，这里兜底拒绝超大载荷，防止单请求打爆 CPU
    if (sentences.length > 500) throw new HttpError(400, "单次最多提交 500 个句子");
    return json(await appendSentences(env, user.id, docId, sentences));
  }

  if (pathname === "/api/documents" && method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT d.id, d.filename, d.exam_type, d.imported_at,
              COUNT(s.id) AS sentence_count
       FROM documents d LEFT JOIN sentences s ON s.document_id = d.id
       WHERE d.user_id = ?
       GROUP BY d.id ORDER BY d.imported_at DESC, d.id DESC`
    )
      .bind(user.id)
      .all();
    return json({ documents: rows.results });
  }

  m = pathname.match(/^\/api\/documents\/(\d+)$/);
  if (m && method === "DELETE") {
    await deleteDocument(env, user.id, Number(m[1]));
    return json({ ok: true });
  }
  if (m && method === "PATCH") {
    const body = await request.json().catch(() => ({}));
    const filename = String(body.filename || "").trim().slice(0, 255);
    if (!filename) throw new HttpError(400, "缺少 filename");
    const r = await env.DB
      .prepare("UPDATE documents SET filename = ? WHERE id = ? AND user_id = ?")
      .bind(filename, Number(m[1]), user.id)
      .run();
    if (!r.meta.changes) throw new HttpError(404, "文档不存在或不属于你");
    return json({ ok: true });
  }

  // 文档内句子检索（预览 / 搜索）：LIKE 对 ASCII 大小写不敏感，无需额外 lower
  m = pathname.match(/^\/api\/documents\/(\d+)\/sentences$/);
  if (m && method === "GET") {
    const docId = Number(m[1]);
    const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    const offset = Math.min(Math.max(Number(url.searchParams.get("offset")) || 0, 0), 100000);
    const doc = await env.DB
      .prepare("SELECT id FROM documents WHERE id = ? AND user_id = ?")
      .bind(docId, user.id)
      .first();
    if (!doc) throw new HttpError(404, "文档不存在或不属于你");
    let where = "s.document_id = ?";
    const binds = [docId];
    if (q) {
      where += " AND s.text LIKE ? ESCAPE '\\'";
      binds.push(`%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`);
    }
    const totalRow = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM sentences s WHERE ${where}`)
      .bind(...binds)
      .first();
    const rows = await env.DB
      .prepare(`SELECT s.id, s.text, s.position FROM sentences s WHERE ${where} ORDER BY s.position LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all();
    return json({ total: totalRow?.n || 0, limit, sentences: rows.results });
  }

  // ---------- 搜索 ----------
  if (pathname === "/api/search" && method === "GET") {
    const word = (url.searchParams.get("word") || "").trim();
    const examType = (url.searchParams.get("exam_type") || "").trim();
    if (!word) return json({ definition: null, sentences: [], phrase: false });
    return json(await searchWord(env, user.id, word, examType));
  }

  // 输入联想：从前缀出发，在当前用户导入的真题词表里找高频词（查词下拉 + 相近词兜底共用）
  if (pathname === "/api/suggest" && method === "GET") {
    const prefix = (url.searchParams.get("prefix") || "").trim().toLowerCase();
    if (!/^[a-z][a-z'-]{0,31}$/.test(prefix)) return json({ suggestions: [] });
    const examType = (url.searchParams.get("exam_type") || "").trim();
    return json({ suggestions: await suggestWords(env, user.id, prefix, examType) });
  }

  m = pathname.match(/^\/api\/sentences\/context$/);
  if (m && method === "GET") {
    const docId = Number(url.searchParams.get("document_id"));
    const position = Number(url.searchParams.get("position"));
    const span = Math.min(Math.max(Number(url.searchParams.get("span")) || 1, 1), 3);
    if (!docId || Number.isNaN(position)) throw new HttpError(400, "缺少 document_id 或 position");
    const rows = await env.DB.prepare(
      `SELECT s.id, s.text, s.position, s.document_id
       FROM sentences s JOIN documents d ON d.id = s.document_id
       WHERE s.document_id = ? AND d.user_id = ? AND s.position BETWEEN ? AND ?
       ORDER BY s.position`
    )
      .bind(docId, user.id, position - span, position + span)
      .all();
    return json({
      center_position: position,
      sentences: rows.results.map((r) => ({ ...r, rel: r.position - position })),
    });
  }

  // ---------- 生词本 ----------
  if (pathname === "/api/wordbook" && method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT wb.id, wb.word, wb.phonetic, wb.translation, wb.definition, wb.added_at,
              wb.familiarity, wb.last_reviewed_at, wb.next_review_at,
              wb.sentence_id, s.text AS sentence_text, s.document_id, s.position,
              d.filename AS source_file, d.exam_type
       FROM wordbook wb
       LEFT JOIN sentences s ON s.id = wb.sentence_id
       LEFT JOIN documents d ON d.id = s.document_id
       WHERE wb.user_id = ?
       ORDER BY wb.added_at DESC, wb.id DESC`
    )
      .bind(user.id)
      .all();
    return json({ words: rows.results });
  }

  if (pathname === "/api/wordbook" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const word = String(body.word || "").trim().toLowerCase().slice(0, 64);
    if (!word) throw new HttpError(400, "缺少 word");
    let sentenceId = body.sentence_id ? Number(body.sentence_id) : null;
    if (sentenceId) {
      // 只允许收藏自己文档里的例句
      const owned = await env.DB.prepare(
        `SELECT s.id FROM sentences s JOIN documents d ON d.id = s.document_id
         WHERE s.id = ? AND d.user_id = ?`
      )
        .bind(sentenceId, user.id)
        .first();
      if (!owned) sentenceId = null;
    }
    await env.DB.prepare(
      `INSERT INTO wordbook (user_id, word, phonetic, translation, definition, sentence_id, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, word) DO UPDATE SET
         phonetic = CASE WHEN excluded.phonetic != '' THEN excluded.phonetic ELSE wordbook.phonetic END,
         translation = CASE WHEN excluded.translation != '' THEN excluded.translation ELSE wordbook.translation END,
         definition = CASE WHEN excluded.definition != '' THEN excluded.definition ELSE wordbook.definition END,
         sentence_id = COALESCE(excluded.sentence_id, wordbook.sentence_id),
         added_at = excluded.added_at`
    )
      .bind(
        user.id,
        word,
        String(body.phonetic || "").slice(0, 128),
        String(body.translation || "").slice(0, 2000),
        String(body.definition || "").slice(0, 4000),
        sentenceId,
        nowIso()
      )
      .run();
    const saved = await env.DB.prepare("SELECT id FROM wordbook WHERE user_id = ? AND word = ?")
      .bind(user.id, word)
      .first();
    return json({ ok: true, id: saved?.id ?? null });
  }

  // 备份恢复：批量写入生词本，保留备份里的熟悉度 / 收藏时间（前端分块调用）
  if (pathname === "/api/wordbook/restore" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const rows = Array.isArray(body.words) ? body.words.slice(0, 200) : [];
    if (!rows.length) return json({ ok: true, restored: 0 });

    // 先批量校验 sentence_id 归属，非法引用降级为无例句收藏
    const wantedSids = [...new Set(rows.map((r) => Number(r.sentence_id)).filter(Boolean))];
    const owned = new Set();
    for (const c of chunks(wantedSids, IN_CHUNK)) {
      const qs = c.map(() => "?").join(",");
      const found = await env.DB
        .prepare(
          `SELECT s.id FROM sentences s JOIN documents d ON d.id = s.document_id
           WHERE s.id IN (${qs}) AND d.user_id = ?`
        )
        .bind(...c, user.id)
        .all();
      for (const r of found.results) owned.add(r.id);
    }

    let restored = 0;
    for (const c of chunks(rows, BATCH_CHUNK)) {
      await env.DB.batch(
        c.map((r) => {
          const word = String(r.word || "").trim().toLowerCase().slice(0, 64);
          const sid = owned.has(Number(r.sentence_id)) ? Number(r.sentence_id) : null;
          const familiarity = Math.max(0, Math.min(5, Math.round(Number(r.familiarity) || 0)));
          restored += 1;
          return env.DB.prepare(
            `INSERT INTO wordbook (user_id, word, phonetic, translation, definition, sentence_id, added_at, familiarity, last_reviewed_at, next_review_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, word) DO UPDATE SET
               phonetic = CASE WHEN excluded.phonetic != '' THEN excluded.phonetic ELSE wordbook.phonetic END,
               translation = CASE WHEN excluded.translation != '' THEN excluded.translation ELSE wordbook.translation END,
               definition = CASE WHEN excluded.definition != '' THEN excluded.definition ELSE wordbook.definition END,
               sentence_id = COALESCE(excluded.sentence_id, wordbook.sentence_id),
               added_at = excluded.added_at,
               familiarity = excluded.familiarity,
               last_reviewed_at = excluded.last_reviewed_at,
               next_review_at = excluded.next_review_at`
          ).bind(
            user.id,
            word,
            String(r.phonetic || "").slice(0, 128),
            String(r.translation || "").slice(0, 2000),
            String(r.definition || "").slice(0, 4000),
            sid,
            String(r.added_at || nowIso()).slice(0, 32),
            familiarity,
            String(r.last_reviewed_at || "").slice(0, 32),
            String(r.next_review_at || "").slice(0, 32)
          );
        })
      );
    }
    return json({ ok: true, restored });
  }

  m = pathname.match(/^\/api\/wordbook\/(\d+)$/);
  if (m && method === "DELETE") {
    await env.DB.prepare("DELETE FROM wordbook WHERE id = ? AND user_id = ?").bind(Number(m[1]), user.id).run();
    return json({ ok: true });
  }

  // 复习评分：familiarity 0-5（忘记降 1 / 模糊不动 / 认识升 1，由前端算好传最终值）。
  // next_review_at 由前端按本地时区算好传入；review_date 是前端本地日期，用于统计与打卡。
  if (pathname === "/api/wordbook/review" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const id = Number(body.id);
    const familiarity = Number(body.familiarity);
    if (!id || Number.isNaN(familiarity) || familiarity < 0 || familiarity > 5) {
      throw new HttpError(400, "参数不合法：需要 id 与 0-5 的 familiarity");
    }
    const nextReviewAt = String(body.next_review_at || "").trim();
    if (nextReviewAt && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(nextReviewAt)) {
      throw new HttpError(400, "next_review_at 格式应为 YYYY-MM-DD HH:MM:SS");
    }
    const gradedAs = ["forget", "fuzzy", "know"].includes(body.graded_as) ? body.graded_as : "";
    const reviewDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.review_date || ""))
      ? String(body.review_date)
      : nowIso().slice(0, 10);

    const row = await env.DB
      .prepare("SELECT id, word FROM wordbook WHERE id = ? AND user_id = ?")
      .bind(id, user.id)
      .first();
    if (!row) throw new HttpError(404, "生词不存在或不属于你");
    const now = nowIso();
    await env.DB.batch([
      env.DB
        .prepare("UPDATE wordbook SET familiarity = ?, last_reviewed_at = ?, next_review_at = ? WHERE id = ? AND user_id = ?")
        .bind(Math.round(familiarity), now, nextReviewAt, id, user.id),
      env.DB
        .prepare(
          `INSERT INTO review_log (user_id, wordbook_id, word, graded_as, familiarity, review_date, reviewed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(user.id, id, row.word, gradedAs, Math.round(familiarity), reviewDate, now),
    ]);
    return json({ ok: true, next_review_at: nextReviewAt });
  }

  // 学习统计：按客户端本地日期聚合最近复习量 + 全量累计（连续打卡在前端由 daily 推导）
  if (pathname === "/api/stats" && method === "GET") {
    const since = url.searchParams.get("since") || "";
    const sinceDate = /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : nowIso().slice(0, 10);
    const daily = await env.DB
      .prepare(
        `SELECT review_date AS date, COUNT(*) AS n FROM review_log
         WHERE user_id = ? AND review_date >= ? GROUP BY review_date`
      )
      .bind(user.id, sinceDate)
      .all();
    const agg = await env.DB
      .prepare(
        "SELECT COUNT(*) AS total_reviews, COUNT(DISTINCT word) AS distinct_words FROM review_log WHERE user_id = ?"
      )
      .bind(user.id)
      .first();
    return json({
      daily: daily.results,
      total_reviews: agg?.total_reviews || 0,
      distinct_words: agg?.distinct_words || 0,
    });
  }

  // 生词本批量操作：删除 / 直接设置熟悉度（不写 review_log，这不是真实复习）
  if (pathname === "/api/wordbook/batch" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "");
    const ids = (Array.isArray(body.ids) ? body.ids : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return json({ ok: true, affected: 0 });
    if (ids.length > 500) throw new HttpError(400, "一次最多操作 500 个生词");
    let affected = 0;
    if (action === "delete") {
      for (const c of chunks(ids, IN_CHUNK)) {
        const qs = c.map(() => "?").join(",");
        const r = await env.DB
          .prepare(`DELETE FROM wordbook WHERE user_id = ? AND id IN (${qs})`)
          .bind(user.id, ...c)
          .run();
        affected += r.meta.changes || 0;
      }
    } else if (action === "familiarity") {
      const f = Math.max(0, Math.min(5, Math.round(Number(body.familiarity) || 0)));
      for (const c of chunks(ids, IN_CHUNK)) {
        const qs = c.map(() => "?").join(",");
        const r = await env.DB
          .prepare(`UPDATE wordbook SET familiarity = ? WHERE user_id = ? AND id IN (${qs})`)
          .bind(f, user.id, ...c)
          .run();
        affected += r.meta.changes || 0;
      }
    } else {
      throw new HttpError(400, "未知操作：action 需为 delete 或 familiarity");
    }
    return json({ ok: true, affected });
  }

  // ---------- 词典（缓存 + 在线兜底） ----------
  if (pathname === "/api/dictionary" && method === "GET") {
    const word = (url.searchParams.get("word") || "").trim().toLowerCase();
    if (!word) throw new HttpError(400, "缺少 word");
    return json({ definition: await getDefinitionCached(env, word) });
  }

  // ---------- LLM 代理（用当前用户自己配置的 Key） ----------
  if (pathname === "/api/llm/define" && method === "POST") {
    const settings = await getUserSettings(env, user.id);
    const body = await request.json().catch(() => ({}));
    const word = String(body.word || "").trim().toLowerCase().slice(0, 64);
    if (!word) throw new HttpError(400, "缺少 word");
    const def = await llmDefine(settings, word);
    await cacheDefinition(env, def);
    return json({ definition: def });
  }

  if (pathname === "/api/llm/translate" && method === "POST") {
    const settings = await getUserSettings(env, user.id);
    const body = await request.json().catch(() => ({}));
    const text = String(body.text || "").trim();
    if (!text) throw new HttpError(400, "缺少 text");
    const zh = await llmTranslate(settings, text);
    return json({ zh });
  }

  // ---------- MinerU OCR 代理（用当前用户自己配置的 Token） ----------
  if (pathname === "/api/mineru/upload-urls" && method === "POST") {
    const settings = await getUserSettings(env, user.id);
    if (!settings.mineru_api_token) throw new HttpError(400, "尚未配置 MinerU API Token，请到「设置」页填写");
    const body = await request.json().catch(() => ({}));
    const files = Array.isArray(body.files) ? body.files.slice(0, 20) : [];
    if (!files.length) throw new HttpError(400, "缺少 files");
    const data = await mineruRequestUploadUrls(settings.mineru_api_token, files);
    return json({ batchId: data.batch_id, fileUrls: data.file_urls || [] });
  }

  if (pathname === "/api/mineru/upload" && method === "POST") {
    const target = url.searchParams.get("url") || "";
    if (!isMineruDownloadUrlAllowed(target)) throw new HttpError(400, "上传地址不在 MinerU 允许的域名内");
    const upstream = await fetch(target, {
      method: "PUT",
      body: request.body,
      headers: { "Content-Type": request.headers.get("Content-Type") || "application/pdf" },
    });
    return json({ ok: upstream.ok, status: upstream.status });
  }

  m = pathname.match(/^\/api\/mineru\/batch\/([\w-]+)$/);
  if (m && method === "GET") {
    const settings = await getUserSettings(env, user.id);
    if (!settings.mineru_api_token) throw new HttpError(400, "尚未配置 MinerU API Token");
    const data = await mineruBatchResult(settings.mineru_api_token, m[1]);
    return json(data);
  }

  if (pathname === "/api/mineru/download" && method === "GET") {
    const target = url.searchParams.get("url") || "";
    if (!isMineruDownloadUrlAllowed(target)) throw new HttpError(400, "下载地址不在 MinerU 允许的域名内");
    const upstream = await fetch(target, { signal: AbortSignal.timeout(120000) });
    if (!upstream.ok) throw new HttpError(502, `MinerU 结果下载失败：HTTP ${upstream.status}`);
    return new Response(upstream.body, {
      headers: { "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff" },
    });
  }

  // ---------- 备份导出（仅当前用户自己的数据） ----------
  if (pathname === "/api/export" && method === "GET") {
    const dump = {};
    dump.documents = await env.DB.prepare("SELECT * FROM documents WHERE user_id = ?").bind(user.id).all()
      .then((r) => r.results);
    dump.sentences = await env.DB.prepare(
      "SELECT s.* FROM sentences s JOIN documents d ON d.id = s.document_id WHERE d.user_id = ?"
    )
      .bind(user.id)
      .all()
      .then((r) => r.results);
    dump.words = await env.DB.prepare(
      `SELECT DISTINCT w.* FROM words w
       JOIN word_sentences ws ON ws.word_id = w.id
       JOIN sentences s ON s.id = ws.sentence_id
       JOIN documents d ON d.id = s.document_id
       WHERE d.user_id = ?`
    )
      .bind(user.id)
      .all()
      .then((r) => r.results);
    dump.word_sentences = await env.DB.prepare(
      `SELECT ws.* FROM word_sentences ws
       JOIN sentences s ON s.id = ws.sentence_id
       JOIN documents d ON d.id = s.document_id
       WHERE d.user_id = ?`
    )
      .bind(user.id)
      .all()
      .then((r) => r.results);
    dump.wordbook = await env.DB.prepare("SELECT * FROM wordbook WHERE user_id = ?").bind(user.id).all()
      .then((r) => r.results);
    dump.user_settings = await env.DB.prepare("SELECT key, value FROM user_settings WHERE user_id = ?")
      .bind(user.id)
      .all()
      .then((r) => r.results);
    dump.exported_at = nowIso();
    const stamp = nowIso().slice(0, 10).replaceAll("-", "");
    return new Response(JSON.stringify(dump, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="ielts-vocab-backup-${stamp}.json"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  throw new HttpError(404, `未知接口：${method} ${pathname}`);
}

// ---------------------------------------------------------------------------
// 认证路由
// ---------------------------------------------------------------------------

// 认证请求限速：记一条本次请求 + 顺手清理 1 小时前的旧记录，超限直接 429
async function authRateLimit(env, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const windowStart = new Date(Date.now() - AUTH_RATE_WINDOW_MIN * 60000).toISOString().replace("T", " ").slice(0, 19);
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ? AND attempted_at >= ?")
    .bind(ip, windowStart)
    .first();
  if ((row?.n || 0) >= AUTH_RATE_LIMIT) {
    throw new HttpError(429, `尝试过于频繁，请 ${AUTH_RATE_WINDOW_MIN} 分钟后再试`);
  }
  const staleBefore = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO auth_attempts (ip, attempted_at) VALUES (?, ?)").bind(ip, nowIso()),
    env.DB.prepare("DELETE FROM auth_attempts WHERE attempted_at < ?").bind(staleBefore),
  ]);
}

async function register(request, env) {
  await authRateLimit(env, request);
  const body = await request.json().catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const regCode = String(body.reg_code || "").trim();
  if (!/^[a-zA-Z0-9_-]{3,24}$/.test(username)) {
    throw new HttpError(400, "用户名需为 3-24 位字母、数字、下划线或短横线");
  }
  if (password.length < 6 || password.length > 128) throw new HttpError(400, "密码至少 6 位");

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  const isFirst = countRow.n === 0;

  if (!isFirst) {
    const required = await getSiteSetting(env, "registration_code");
    if (required && regCode !== required) {
      throw new HttpError(403, "本站已开启注册码，请向站长索取后填写");
    }
  }

  const dup = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  if (dup) throw new HttpError(409, "用户名已被占用");

  let result;
  try {
    result = await env.DB
      .prepare("INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)")
      .bind(username, await hashPassword(password), isFirst ? 1 : 0, nowIso())
      .run();
  } catch (e) {
    // 并发注册同一用户名时 dup 查重拦不住，UNIQUE 约束兜底；别把数据库报错原文当 500 漏出去
    if (String(e?.message || "").includes("UNIQUE")) throw new HttpError(409, "用户名已被占用");
    throw e;
  }
  const userId = result.meta.last_row_id;

  // 首个注册 = 站长，认领多用户改造前的历史数据与配置
  if (isFirst) {
    await env.DB.batch([
      env.DB.prepare("UPDATE documents SET user_id = ? WHERE user_id = 0").bind(userId),
      env.DB.prepare("UPDATE wordbook SET user_id = ? WHERE user_id = 0").bind(userId),
      env.DB.prepare("UPDATE user_settings SET user_id = ? WHERE user_id = -1").bind(userId),
    ]);
  }

  const token = await createSession(env, userId);
  return json(
    { ok: true, user: { id: userId, username, is_admin: isFirst } },
    200,
    { "Set-Cookie": sessionCookie(token) }
  );
}

async function login(request, env) {
  await authRateLimit(env, request);
  const body = await request.json().catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const row = await env.DB
    .prepare("SELECT id, username, is_admin, password_hash FROM users WHERE username = ?")
    .bind(username)
    .first();
  // 用户不存在与密码错误返回同一句话，不泄露用户名是否存在；
  // 对不存在的用户也跑一次同代价的哈希验证，避免响应时间差绕过文案层面的一致性
  if (!row) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    throw new HttpError(401, "用户名或密码错误");
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    throw new HttpError(401, "用户名或密码错误");
  }
  const token = await createSession(env, row.id);
  return json(
    { ok: true, user: { id: row.id, username: row.username, is_admin: Boolean(row.is_admin) } },
    200,
    { "Set-Cookie": sessionCookie(token) }
  );
}

// ---------------------------------------------------------------------------
// 导入：写句子 + 建倒排索引（浏览器已完成分句/分词/去重）
// ---------------------------------------------------------------------------

async function appendSentences(env, userId, docId, sentences) {
  const doc = await env.DB
    .prepare("SELECT id FROM documents WHERE id = ? AND user_id = ?")
    .bind(docId, userId)
    .first();
  if (!doc) throw new HttpError(404, "文档不存在（可能尚未创建、已被删除或不属于你）");

  const clean = sentences
    .map((s) => ({
      // 文本与词元做长度截断：合法分句结果远达不到上限，防异常载荷撑爆行体积
      text: String(s?.text ?? "").trim().slice(0, 4000),
      tokens: Array.isArray(s?.tokens)
        ? s.tokens.slice(0, 400).map((t) => String(t).toLowerCase().slice(0, 64))
        : [],
    }))
    .filter((s) => s.text);
  if (!clean.length) return { inserted: 0, start: 0 };

  const maxRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(position), -1) AS m FROM sentences WHERE document_id = ?"
  )
    .bind(docId)
    .first();
  const start = maxRow.m + 1;

  // 1) 插入句子
  for (const c of chunks(clean, BATCH_CHUNK)) {
    await env.DB.batch(
      c.map((s, i) =>
        env.DB
          .prepare("INSERT INTO sentences (document_id, text, position) VALUES (?, ?, ?)")
          .bind(docId, s.text, start + i)
      )
    );
  }

  // 2) 取回句子 id（按 position 精确对齐，不做任何自增假设）
  const idRows = await env.DB.prepare(
    "SELECT id, position FROM sentences WHERE document_id = ? AND position >= ? AND position < ?"
  )
    .bind(docId, start, start + clean.length)
    .all();
  const idByPos = new Map(idRows.results.map((r) => [r.position, r.id]));
  // 与 clean 数组同序的 id 列表：备份恢复靠它做旧句子 id → 新句子 id 的映射
  const ids = clean.map((_, i) => idByPos.get(start + i) || null);

  // 3) 词表：本批唯一词 → lemma；查已有 → 插新词 → 回查 id
  const wordMap = new Map();
  for (const s of clean) {
    for (const t of s.tokens) {
      if (t.length >= 2 && !wordMap.has(t)) wordMap.set(t, lemmatize(t));
    }
  }
  const wordList = [...wordMap.keys()];
  const wordIds = new Map();
  const selectIds = async (words) => {
    for (const c of chunks(words, IN_CHUNK)) {
      const qs = c.map(() => "?").join(",");
      const rows = await env.DB.prepare(`SELECT id, word FROM words WHERE word IN (${qs})`).bind(...c).all();
      for (const r of rows.results) wordIds.set(r.word, r.id);
    }
  };
  await selectIds(wordList);
  const missing = wordList.filter((w) => !wordIds.has(w));
  if (missing.length) {
    // OR IGNORE：词表全局共享（word UNIQUE），与其他用户/标签页并发导入撞上同一个新词时，
    // 不让 UNIQUE 冲突把整次导入打挂；被忽略的词随后回查拿到对方插入的 id
    for (const c of chunks(missing, BATCH_CHUNK)) {
      await env.DB.batch(
        c.map((w) =>
          env.DB.prepare("INSERT OR IGNORE INTO words (word, lemma) VALUES (?, ?)").bind(w, wordMap.get(w))
        )
      );
    }
    await selectIds(missing);
  }

  // 4) 倒排索引
  const pairs = [];
  clean.forEach((s, i) => {
    const sid = idByPos.get(start + i);
    if (!sid) return;
    const seen = new Set();
    for (const t of s.tokens) {
      if (t.length < 2 || seen.has(t)) continue;
      seen.add(t);
      const wid = wordIds.get(t);
      if (wid) pairs.push([wid, sid]);
    }
  });
  for (const c of chunks(pairs, BATCH_CHUNK)) {
    await env.DB.batch(
      c.map(([wid, sid]) =>
        env.DB
          .prepare("INSERT OR IGNORE INTO word_sentences (word_id, sentence_id) VALUES (?, ?)")
          .bind(wid, sid)
      )
    );
  }

  return { inserted: clean.length, start, ids, new_words: missing.length };
}

async function deleteDocument(env, userId, docId) {
  const doc = await env.DB
    .prepare("SELECT id FROM documents WHERE id = ? AND user_id = ?")
    .bind(docId, userId)
    .first();
  if (!doc) throw new HttpError(404, "文档不存在或不属于你");
  const sentenceRows = await env.DB.prepare("SELECT id FROM sentences WHERE document_id = ?")
    .bind(docId)
    .all();
  const sids = sentenceRows.results.map((r) => r.id);
  for (const c of chunks(sids, IN_CHUNK)) {
    const qs = c.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM word_sentences WHERE sentence_id IN (${qs})`).bind(...c).run();
    // 生词本收藏的例句随文档删除，悬空引用一并置空（LEFT JOIN 时不再查空气行）
    await env.DB.prepare(`UPDATE wordbook SET sentence_id = NULL WHERE user_id = ? AND sentence_id IN (${qs})`)
      .bind(userId, ...c)
      .run();
  }
  await env.DB.prepare("DELETE FROM sentences WHERE document_id = ?").bind(docId).run();
  await env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(docId).run();
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

function examFilterSql(examType) {
  return examType ? " AND d.exam_type = ?" : "";
}

// 联想查询：从该用户自己的文档出发（documents 有 user_id 索引，逐表走小结果集），
// 词形 / 词干前缀皆可命中，按出现句数排序
async function suggestWords(env, userId, prefix, examType) {
  const escaped = prefix.replace(/[\\%_]/g, (ch) => "\\" + ch);
  const pattern = `${escaped}%`;
  const sql = `SELECT w.word, COUNT(*) AS cnt
    FROM documents d
    JOIN sentences s ON s.document_id = d.id
    JOIN word_sentences ws ON ws.sentence_id = s.id
    JOIN words w ON w.id = ws.word_id
    WHERE d.user_id = ? AND (w.word LIKE ? ESCAPE '\\' OR w.lemma LIKE ? ESCAPE '\\')${examFilterSql(examType)}
    GROUP BY w.id
    ORDER BY cnt DESC, w.word
    LIMIT 8`;
  const bind = examType ? [userId, pattern, pattern, examType] : [userId, pattern, pattern];
  const rows = await env.DB.prepare(sql).bind(...bind).all();
  return rows.results;
}

async function findSentences(env, userId, word, examType) {
  const sql = `SELECT DISTINCT s.id, s.text, s.document_id, s.position, d.filename, d.exam_type
    FROM words w
    JOIN word_sentences ws ON ws.word_id = w.id
    JOIN sentences s ON s.id = ws.sentence_id
    JOIN documents d ON d.id = s.document_id
    WHERE (w.word = ? OR w.lemma = ?) AND d.user_id = ?${examFilterSql(examType)}
    ORDER BY d.exam_type, s.document_id, s.position
    LIMIT ${SENTENCE_LIMIT}`;
  const bind = examType ? [word, word, userId, examType] : [word, word, userId];
  const rows = await env.DB.prepare(sql).bind(...bind).all();
  return rows.results;
}

async function findSentencesByPhrase(env, userId, phrase, examType) {
  const escaped = phrase.replace(/[\\%_]/g, (ch) => "\\" + ch);
  const sql = `SELECT s.id, s.text, s.document_id, s.position, d.filename, d.exam_type
    FROM sentences s
    JOIN documents d ON d.id = s.document_id
    WHERE s.text LIKE ? ESCAPE '\\' AND d.user_id = ?${examFilterSql(examType)}
    ORDER BY d.exam_type, s.document_id, s.position
    LIMIT ${SENTENCE_LIMIT}`;
  const bind = examType ? [`%${escaped}%`, userId, examType] : [`%${escaped}%`, userId];
  const rows = await env.DB.prepare(sql).bind(...bind).all();
  return rows.results;
}

async function searchWord(env, userId, rawWord, examType) {
  const word = rawWord.trim().toLowerCase();
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(word)) {
    // 中文查询：从词典缓存反查释义命中的词，再联查这些词的真题例句
    return searchByChinese(env, userId, rawWord.trim(), examType);
  }
  const isPhrase = /\s/.test(word);
  if (isPhrase) {
    const sentences = await findSentencesByPhrase(env, userId, word, examType);
    return { definition: null, sentences, phrase: true };
  }
  const definition = await getDefinitionCached(env, word);
  let sentences = await findSentences(env, userId, word, examType);
  let lemmaUsed = false;
  if (!sentences.length) {
    const lemma = lemmatize(word);
    if (lemma !== word) {
      sentences = await findSentences(env, userId, lemma, examType);
      lemmaUsed = sentences.length > 0;
    }
  }
  if (!sentences.length && word.length >= 3) {
    // 词干前缀兜底：搜 run 也能命中 running / runs（规则式还原把 running 归为 runn，
    // 精确/lemma 查询都会漏，前缀匹配补上这一层）
    sentences = await findSentencesByLemmaPrefix(env, userId, word, examType);
    lemmaUsed = sentences.length > 0;
  }
  return { definition, sentences, phrase: false, lemma_used: lemmaUsed };
}

// 中文反查：词典缓存的 translation/definition LIKE 命中 → 候选词 → 一次 IN 联查全部真题例句。
// sentence 带回 matched_word，前端据此高亮并让「收录」挂对单词。
async function searchByChinese(env, userId, term, examType) {
  const escaped = term.replace(/[\\%_]/g, (ch) => "\\" + ch);
  const pattern = `%${escaped}%`;
  const candidates = await env.DB.prepare(
    `SELECT word, phonetic, translation FROM dictionary_cache
     WHERE translation LIKE ? ESCAPE '\\' OR definition LIKE ? ESCAPE '\\'
     ORDER BY updated_at DESC LIMIT 12`
  )
    .bind(pattern, pattern)
    .all();
  const words = candidates.results.map((r) => r.word);
  if (!words.length) {
    return { definition: null, sentences: [], phrase: false, reverse: { term, words: [] } };
  }

  const rows = await env.DB.prepare(
    `SELECT DISTINCT s.id, s.text, s.document_id, s.position, d.filename, d.exam_type, w.word AS matched_word
     FROM words w
     JOIN word_sentences ws ON ws.word_id = w.id
     JOIN sentences s ON s.id = ws.sentence_id
     JOIN documents d ON d.id = s.document_id
     WHERE w.word IN (${words.map(() => "?").join(",")}) AND d.user_id = ?${examFilterSql(examType)}`
  )
    .bind(...words, userId, ...(examType ? [examType] : []))
    .all();

  // 按候选词的相关度排序：释义更短（更精准）的词排前，同词内按文档/位置
  const rank = new Map(words.map((w, i) => [w, i]));
  const sentences = rows.results
    .sort(
      (a, b) =>
        (rank.get(a.matched_word) ?? 99) - (rank.get(b.matched_word) ?? 99) ||
        a.document_id - b.document_id ||
        a.position - b.position
    )
    .slice(0, SENTENCE_LIMIT);
  return {
    definition: null,
    sentences,
    phrase: false,
    reverse: { term, words: candidates.results },
  };
}

async function findSentencesByLemmaPrefix(env, userId, word, examType) {
  // 词干来自用户输入，先转义 LIKE 通配符（搜 100% 不该变成通配查询）
  const pattern = `${word.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
  const sql = `SELECT DISTINCT s.id, s.text, s.document_id, s.position, d.filename, d.exam_type
    FROM words w
    JOIN word_sentences ws ON ws.word_id = w.id
    JOIN sentences s ON s.id = ws.sentence_id
    JOIN documents d ON d.id = s.document_id
    WHERE (w.lemma LIKE ? ESCAPE '\\' OR w.word LIKE ? ESCAPE '\\') AND w.word != ? AND d.user_id = ?${examFilterSql(examType)}
    ORDER BY d.exam_type, s.document_id, s.position
    LIMIT ${SENTENCE_LIMIT}`;
  const bind = examType ? [pattern, pattern, word, userId, examType] : [pattern, pattern, word, userId];
  const rows = await env.DB.prepare(sql).bind(...bind).all();
  return rows.results;
}

// ---------------------------------------------------------------------------
// 词典缓存（dictionaryapi.dev 在线兜底 + LLM 生成结果统一入缓存）
// ---------------------------------------------------------------------------

function shapeDefinition(row) {
  let examples = [];
  try {
    examples = row.examples ? JSON.parse(row.examples) : [];
  } catch {
    examples = [];
  }
  return {
    word: row.word,
    phonetic: row.phonetic || "",
    translation: row.translation || "",
    definition: row.definition || "",
    examples: Array.isArray(examples) ? examples : [],
    source: row.source || "",
  };
}

async function cacheDefinition(env, def) {
  await env.DB.prepare(
    `INSERT INTO dictionary_cache (word, phonetic, translation, definition, examples, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(word) DO UPDATE SET
       phonetic = excluded.phonetic,
       translation = CASE WHEN excluded.translation != '' THEN excluded.translation ELSE dictionary_cache.translation END,
       definition = excluded.definition,
       examples = excluded.examples,
       source = excluded.source,
       updated_at = excluded.updated_at`
  )
    .bind(
      def.word.toLowerCase(),
      def.phonetic || "",
      def.translation || "",
      def.definition || "",
      JSON.stringify(def.examples || []),
      def.source || "",
      nowIso()
    )
    .run();
}

async function getDefinitionCached(env, word) {
  const row = await env.DB.prepare("SELECT * FROM dictionary_cache WHERE word = ?").bind(word).first();
  if (row) return shapeDefinition(row);
  const online = await lookupOnline(word);
  if (!online) return null;
  await cacheDefinition(env, online);
  return online;
}
