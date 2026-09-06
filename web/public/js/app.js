// 真题词库 · Web 版前端逻辑
import {
  extractAnyFile,
  looksLikeScanned,
  unzipMarkdown,
  buildSentencesPayload,
  sentenceTokens,
  lemmatize,
  tokenizeWords,
} from "./pipeline.js";

const EXAM_TYPES = ["IELTS", "CET-4", "CET-6", "TOEFL", "GRE", "Other"];
const UPLOAD_CHUNK = 400; // 每次提交给 Worker 的句子数（控制单请求体积与 CPU）

const $ = (sel) => document.querySelector(sel);

const state = {
  user: null,
  settings: null,
  examFilter: "",
  currentWord: "",
  lastResult: null,
  debounceTimer: null,
};

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  let resp;
  try {
    resp = await fetch(path, opts); // 同源请求自动携带 session cookie
  } catch (e) {
    throw new Error(`网络请求失败：${e.message}`);
  }
  if (resp.status === 401 && state.user) {
    // 会话过期：切回登录视图
    enterAuthMode("登录已过期，请重新登录");
    throw new Error("登录已过期");
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `请求失败（HTTP ${resp.status}）`);
  return data;
}

let toastTimer = null;
function toast(msg, type = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 3200);
}

function escapeHtml(s) {
  // 引号也转义：同样的函数会用在 title="…" 等属性上下文里
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 释义/例句正文 → 高亮当前词后的 HTML
function highlightHtml(text, terms) {
  const escaped = escapeHtml(text);
  const valid = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!valid.length) return escaped;
  // 词表也按正文同样的方式转义（' → &#39; 等），否则 don't 这类缩写在转义后的文本里永远匹配不上
  const re = new RegExp(`(${valid.map((t) => escapeRegExp(escapeHtml(t))).join("|")})`, "gi");
  return escaped.replace(re, "<mark>$1</mark>");
}

function badgeClass(examType) {
  // exam_type 可能经备份恢复等路径带入任意字符串（后端只截长度），class 属性同样要转义
  return `badge badge-${escapeHtml(String(examType || "Other").replace("-", ""))}`;
}

// 双击例句文本时取选中的英文单词（浏览器双击会自动选中一个词）
function selectedEnglishWord() {
  const sel = window.getSelection();
  const text = sel ? String(sel.toString()).trim() : "";
  const m = text.match(/^[A-Za-z][A-Za-z'-]{0,63}$/);
  return m ? text.toLowerCase() : "";
}

function bindDblClickSearch(el) {
  if (!el) return;
  if (el.dataset.dblBound) return; // 文档预览"加载更多"会重复调用，别给同一容器叠监听器
  el.dataset.dblBound = "1";
  el.title = "双击句中单词可直接查询";
  el.addEventListener("dblclick", () => {
    const w = selectedEnglishWord();
    if (!w) return;
    $("#search-input").value = w;
    doSearch(w, true);
  });
}

function speak(text) {
  if (!("speechSynthesis" in window)) return toast("当前浏览器不支持语音朗读");
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = 0.95;
  window.speechSynthesis.speak(u);
}

function fmtDate(s) {
  return String(s || "").replace("T", " ").slice(0, 16);
}

// ---------------------------------------------------------------------------
// 主题：auto / light / dark（localStorage iv_theme）
// <head> 里的内联脚本已在渲染前应用 data-theme，这里只负责切换按钮与系统联动
// ---------------------------------------------------------------------------

const THEME_KEY = "iv_theme";
const THEME_ICONS = {
  auto: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18V4a8 8 0 0 1 0 16z"/></svg>',
  light: '<svg viewBox="0 0 24 24"><path d="M12 18a6 6 0 1 1 0-12 6 6 0 0 1 0 12zm0-14.5a.9.9 0 0 1-.9-.9V1a.9.9 0 1 1 1.8 0v1.6a.9.9 0 0 1-.9.9zm0 21a.9.9 0 0 1-.9-.9V22a.9.9 0 1 1 1.8 0v1.6a.9.9 0 0 1-.9.9zM20.5 12a.9.9 0 0 1 .9-.9H23a.9.9 0 1 1 0 1.8h-1.6a.9.9 0 0 1-.9-.9zM1 12a.9.9 0 0 1 .9-.9h1.6a.9.9 0 1 1 0 1.8H1.9A.9.9 0 0 1 1 12zm16.16 5.16a.9.9 0 0 1 1.27 0l1.13 1.13a.9.9 0 1 1-1.27 1.27l-1.13-1.13a.9.9 0 0 1 0-1.27zM4.44 4.44a.9.9 0 0 1 1.27 0l1.13 1.13a.9.9 0 1 1-1.27 1.27L4.44 5.71a.9.9 0 0 1 0-1.27zm13.99 1.13 1.13-1.13a.9.9 0 1 1 1.27 1.27l-1.13 1.13a.9.9 0 1 1-1.27-1.27zM4.44 19.56l1.13-1.13a.9.9 0 0 1 1.27 1.27l-1.13 1.13a.9.9 0 1 1-1.27-1.27z"/></svg>',
  dark: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-5.4-5.4c0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>',
};
const THEME_LABELS = { auto: "跟随系统", light: "亮色", dark: "暗色" };
const THEME_ORDER = ["auto", "light", "dark"];

function getThemeMode() {
  let mode = "auto";
  try {
    mode = localStorage.getItem(THEME_KEY) || "auto";
  } catch {}
  return THEME_ORDER.includes(mode) ? mode : "auto";
}

function applyTheme(mode) {
  const dark = mode === "dark" || (mode === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const btn = $("#theme-toggle");
  if (btn) {
    btn.innerHTML = THEME_ICONS[mode];
    btn.title = `主题：${THEME_LABELS[mode]}（点击切换）`;
  }
}

$("#theme-toggle").addEventListener("click", () => {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(getThemeMode()) + 1) % THEME_ORDER.length];
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {}
  applyTheme(next);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  if (getThemeMode() === "auto") applyTheme("auto");
});
applyTheme(getThemeMode());

// ---------------------------------------------------------------------------
// 搜索历史（localStorage，最多 12 条，去重）
// ---------------------------------------------------------------------------

const RECENT_KEY = "iv_recent_words";
const RECENT_MAX = 12;

function loadRecentWords() {
  try {
    const arr = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter((w) => typeof w === "string" && w.trim()).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecentWord(word) {
  word = String(word || "").trim();
  if (!word) return;
  const next = [word, ...loadRecentWords().filter((w) => w.toLowerCase() !== word.toLowerCase())].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

function clearRecentWords() {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {}
  renderWelcome();
}

// ---------------------------------------------------------------------------
// 认证：登录 / 注册 / 退出
// ---------------------------------------------------------------------------

let authMode = "login";

function enterAuthMode(message = "") {
  state.user = null;
  state.settings = null; // 换账号前清掉上一账号的配置状态，避免「已配置 Key」等提示残留
  // 复习浮层是全屏遮罩，不关会把登录表单压在下面，用户看起来像卡死
  review.open = false;
  $("#review-overlay").hidden = true;
  wordbookCache = [];
  wbWordMap = new Map();
  // 批量管理的勾选状态跟着账号走：换号时残留的勾选会让下一个账号误删生词
  wbBatch.on = false;
  wbBatch.ids.clear();
  $("#wb-batch-bar").hidden = true;
  $("#wb-batch-toggle").classList.remove("is-on");
  searchCache.clear();
  documentsCache = []; // 上一账号的文档列表别留给下一个账号（同名提醒/追加下拉都会用到）
  statsCache = null; // 学习统计同理，别把上一账号的打卡/热力图带给下一个账号
  // 「最近查过」也是上一账号的使用痕迹，与其他缓存同一口径：换号即清
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {}
  hideSuggest(); // 联想下拉别挂着上一账号词表里的词
  state.currentWord = "";
  state.lastResult = null;
  document.body.classList.add("auth-mode");
  $("#user-chip").hidden = true;
  $("#auth-password").value = "";
  const err = $("#auth-error");
  if (message) {
    err.textContent = message;
    err.hidden = false;
  } else {
    err.hidden = true;
  }
}

function exitAuthMode(user) {
  state.user = user;
  document.body.classList.remove("auth-mode");
  $("#auth-error").hidden = true;
  $("#user-name").textContent = user.username;
  $("#user-avatar").textContent = user.username.slice(0, 1).toUpperCase();
  $("#user-chip").hidden = false;
}

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll(".auth-tab").forEach((t) => t.classList.toggle("active", t.dataset.auth === mode));
  $("#auth-reg-code-field").hidden = mode === "login";
  $("#auth-submit").textContent = mode === "login" ? "登录" : "注册并进入";
  $("#auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("#auth-error").hidden = true;
}

document.querySelectorAll(".auth-tab").forEach((t) => {
  t.addEventListener("click", () => setAuthMode(t.dataset.auth));
});

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("#auth-submit");
  const err = $("#auth-error");
  const username = $("#auth-username").value.trim();
  const password = $("#auth-password").value;
  submit.disabled = true;
  try {
    const body = { username, password };
    if (authMode === "register") {
      const code = $("#auth-reg-code").value.trim();
      if (code) body.reg_code = code;
    }
    const data = await api(`/api/auth/${authMode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    exitAuthMode(data.user);
    await loadSettings();
    renderChips();
    renderWelcome();
    loadDocuments().catch(() => {});
    refreshWordbookSilent(); // 预热生词本集合，查词页才能显示「已在生词本 / 已收录」
    refreshStudyStats();
    toast(
      authMode === "login"
        ? `欢迎回来，${data.user.username}`
        : `注册成功，欢迎 ${data.user.username}${data.user.is_admin ? "（站长）" : ""}`,
      "ok"
    );
  } catch (err2) {
    err.textContent = err2.message;
    err.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {}
  enterAuthMode();
  toast("已退出登录");
});

// ---------------------------------------------------------------------------
// Tab 切换
// ---------------------------------------------------------------------------

const tabLoaders = {
  search: () => {},
  import: () => loadDocuments(),
  wordbook: () => {
    loadWordbook();
    refreshStudyStats();
  },
  settings: () => loadSettingsForm(),
};

$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === btn));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(`#view-${btn.dataset.tab}`).classList.add("active");
  tabLoaders[btn.dataset.tab]?.();
  // hash 记住当前页：刷新 / 分享后仍停留在同一页（replaceState 不污染历史）
  try {
    history.replaceState(null, "", `#${btn.dataset.tab}`);
  } catch {}
});

// ---------------------------------------------------------------------------
// 查词
// ---------------------------------------------------------------------------

// 会话内查询缓存：同一词 + 同一考试筛选不重复请求（服务端还有 D1 级 dictionary_cache）
const searchCache = new Map();
const SEARCH_CACHE_MAX = 200;
let searchSeq = 0; // 请求序号：响应乱序到达时旧结果直接丢弃，不覆盖新查询的渲染

function renderChips() {
  const box = $("#exam-chips");
  box.innerHTML = "";
  const mk = (label, value) => {
    const b = document.createElement("button");
    b.className = "chip" + (state.examFilter === value ? " active" : "");
    b.textContent = label;
    b.onclick = () => {
      state.examFilter = value;
      renderChips();
      if (state.currentWord) doSearch(state.currentWord, true);
    };
    box.appendChild(b);
  };
  mk("全部", "");
  EXAM_TYPES.forEach((t) => mk(t, t));
}

const SAMPLE_WORDS = ["abandon", "sophisticated", "deliberately", "sustainable", "yield"];

function renderWelcome() {
  const recent = loadRecentWords();
  $("#search-results").innerHTML = `
    <div class="empty-state">
      <div class="glyph">
        <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
      </div>
      <p class="empty-title">查一个单词，看看你在真题里是怎么遇到它的</p>
      <p class="empty-sub">例句全部来自你自己导入的真题，不再是来历不明的词典句</p>
      <div class="due-cta" id="due-cta" hidden></div>
      ${
        recent.length
          ? `<div class="recent-row"><span class="recent-label">最近查过</span>${recent
              .map((w) => `<button class="sample-word" data-w="${escapeHtml(w)}">${escapeHtml(w)}</button>`)
              .join("")}<button class="sample-word recent-clear" data-act="clear-recent">清除</button></div>`
          : ""
      }
      <div class="sample-words">${SAMPLE_WORDS.map((w) => `<button class="sample-word" data-w="${w}">${w}</button>`).join("")}</div>
    </div>`;
  document.querySelectorAll(".sample-word[data-w]").forEach((b) => {
    b.onclick = () => {
      $("#search-input").value = b.dataset.w;
      doSearch(b.dataset.w, true);
    };
  });
  const clearBtn = document.querySelector('[data-act="clear-recent"]');
  if (clearBtn) clearBtn.onclick = clearRecentWords;
  updateWelcomeCta();
}

// 欢迎页「今日待复习」直达 CTA：有到期词时提示并一键开复习（due 范围）
function updateWelcomeCta() {
  const el = $("#due-cta");
  if (!el) return;
  const n = state.user ? computeDueCount() : 0;
  if (!n) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `
    <span class="due-cta-text">📅 今天有 <b>${n}</b> 个生词到了复习时间</span>
    <button class="btn btn-primary btn-sm" data-act="due-review">立即复习</button>`;
  el.querySelector('[data-act="due-review"]').onclick = () => {
    $("#review-scope").value = "due";
    try {
      localStorage.setItem(REVIEW_SCOPE_KEY, "due");
    } catch {}
    document.querySelector('[data-tab="wordbook"]').click();
    startReview();
  };
}

function renderSkeleton() {
  $("#search-results").innerHTML = `
    <div class="skeleton-card">
      <div class="skeleton-line" style="width:34%"></div>
      <div class="skeleton-line" style="width:58%"></div>
      <div class="skeleton-line" style="width:42%"></div>
    </div>
    <div class="skeleton-card">
      <div class="skeleton-line" style="width:86%"></div>
      <div class="skeleton-line" style="width:64%"></div>
    </div>
    <div class="skeleton-card">
      <div class="skeleton-line" style="width:78%"></div>
    </div>`;
}

async function doSearch(word, immediate = false) {
  word = word.trim();
  const seq = ++searchSeq;
  if (!word) {
    state.currentWord = "";
    renderWelcome();
    return;
  }
  state.currentWord = word;

  const key = `${state.examFilter}|${word.toLowerCase()}`;
  if (searchCache.has(key)) {
    state.lastResult = searchCache.get(key);
    pushRecentWord(word); // 缓存命中也是一次真实查询，同样进「最近查过」
    renderSearchResult(word, state.lastResult);
    return;
  }

  if (!immediate) renderSkeleton();
  try {
    const params = new URLSearchParams({ word });
    if (state.examFilter) params.set("exam_type", state.examFilter);
    const data = await api(`/api/search?${params}`);
    if (seq !== searchSeq) return; // 期间用户又发起了别的查询，丢弃过期响应
    state.lastResult = data;
    if (searchCache.size >= SEARCH_CACHE_MAX) searchCache.clear();
    searchCache.set(key, data);
    pushRecentWord(word);
    renderSearchResult(word, data);
  } catch (e) {
    if (seq !== searchSeq) return;
    $("#search-results").innerHTML = `<div class="hint-block">查询失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderSearchResult(word, data) {
  const box = $("#search-results");
  box.innerHTML = "";

  if (data.definition) box.appendChild(buildDefCard(data.definition));

  // 中文反查：顶部给候选词 chips（点词即查），例句按命中词分别高亮
  if (data.reverse) {
    const reverse = data.reverse;
    const head = document.createElement("div");
    head.className = "result-title";
    head.innerHTML = `中文反查「<span class="count">${escapeHtml(reverse.term)}</span>」`;
    box.appendChild(head);
    if (reverse.words.length) {
      const chips = document.createElement("div");
      chips.className = "similar-row";
      chips.innerHTML =
        `<span class="recent-label">释义含该词的 ${reverse.words.length} 个词</span>` +
        reverse.words
          .map(
            (w) =>
              `<button class="sample-word" data-w="${escapeHtml(w.word)}" title="${escapeHtml(w.translation)}">${escapeHtml(w.word)}</button>`
          )
          .join("");
      box.appendChild(chips);
      chips.querySelectorAll(".sample-word").forEach((b) => {
        b.onclick = () => {
          $("#search-input").value = b.dataset.w;
          doSearch(b.dataset.w, true);
        };
      });
    }
  }

  // 高亮词形变体：搜 run 时 running / runs 也标黄（从例句里现收，覆盖前缀兜底命中的形态）
  const terms = collectHighlightTerms(word, data.sentences || [], Boolean(data.lemma_used));

  const sentences = data.sentences || [];
  if (sentences.length) {
    const title = document.createElement("div");
    title.className = "result-title";
    if (data.reverse) {
      title.innerHTML = `相关真题例句 <span class="count">${sentences.length} 条</span>`;
    } else if (data.phrase) {
      title.innerHTML = `短语例句 <span class="count">${sentences.length} 条</span>`;
    } else {
      title.innerHTML = `真题例句 <span class="count">${sentences.length} 条</span>`;
    }
    box.appendChild(title);
    if (data.reverse) {
      // 反查结果按各自命中的词高亮/收录
      sentences.forEach((s, i) => box.appendChild(buildSentenceCard(s, collectHighlightTerms(s.matched_word, [s], false), i, s.matched_word)));
    } else {
      sentences.forEach((s, i) => box.appendChild(buildSentenceCard(s, terms, i, word)));
    }
  } else {
    const empty = document.createElement("div");
    empty.className = "hint-block";
    if (data.reverse) {
      empty.innerHTML = `词典缓存里没有释义含「<b>${escapeHtml(word)}</b>」的词。<br>查过的词越多，反查越准；也可以配置 LLM Key 用 AI 释义。`;
    } else {
      empty.innerHTML = `未在已导入的真题里找到「<b>${escapeHtml(word)}</b>」的例句。<br>多导入几份真题，它就会慢慢出现。`;
    }
    box.appendChild(empty);
    if (!data.reverse) attachSimilarWords(box, word);
  }
}

// 没搜到例句时，从真题词表里推荐相近词（前缀 / 词干命中），点击直接查
async function attachSimilarWords(container, word) {
  const q = word.trim().toLowerCase();
  if (!q || /\s/.test(q)) return;
  const params = new URLSearchParams({ prefix: q });
  if (state.examFilter) params.set("exam_type", state.examFilter);
  let items = [];
  try {
    items = (await api(`/api/suggest?${params}`)).suggestions || [];
  } catch {
    return;
  }
  if (state.currentWord !== word || !items.length) return; // 用户已发起别的查询就不再插
  const div = document.createElement("div");
  div.className = "similar-row";
  div.innerHTML =
    `<span class="recent-label">你的真题里有这些相近词</span>` +
    items
      .map((s) => `<button class="sample-word" data-w="${escapeHtml(s.word)}">${escapeHtml(s.word)}</button>`)
      .join("");
  container.appendChild(div);
  div.querySelectorAll(".sample-word").forEach((b) => {
    b.onclick = () => {
      $("#search-input").value = b.dataset.w;
      doSearch(b.dataset.w, true);
    };
  });
}

function collectHighlightTerms(query, sentences, lemmaUsed) {
  const queryLower = query.toLowerCase();
  const terms = new Set([queryLower]);
  const queryLemma = lemmatize(queryLower);
  if (lemmaUsed && queryLemma !== queryLower) terms.add(queryLemma);
  if (!/\s/.test(queryLower)) {
    for (const s of sentences) {
      for (const t of tokenizeWords(s.text)) {
        if (terms.size >= 14) break;
        // 命中：同词干，或前缀兜底命中的派生形（长度限制防止误伤无关长词）
        if (t === queryLower) continue;
        if (lemmatize(t) === queryLemma || (t.startsWith(queryLower) && t.length <= queryLower.length + 3)) {
          terms.add(t);
        }
      }
    }
  }
  return [...terms];
}

function buildDefCard(def) {
  const card = document.createElement("div");
  card.className = "def-card";

  const head = document.createElement("div");
  head.className = "def-head";
  head.innerHTML = `
    <span class="def-word">${escapeHtml(def.word)}</span>
    ${def.phonetic ? `<span class="def-phonetic">${escapeHtml(def.phonetic)}</span>` : ""}
    <button class="icon-btn" title="朗读单词" data-act="speak">
      <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
    </button>`;
  card.appendChild(head);
  head.querySelector('[data-act="speak"]').onclick = () => speak(def.word);

  if (def.translation) {
    const t = document.createElement("div");
    t.className = "def-translation";
    t.textContent = def.translation;
    card.appendChild(t);
  }
  if (def.definition) {
    const d = document.createElement("div");
    d.className = "def-en";
    d.textContent = def.definition;
    card.appendChild(d);
  }
  const examples = def.examples || [];
  if (examples.length) {
    const wrap = document.createElement("div");
    wrap.className = "def-examples";
    for (const ex of examples.slice(0, 2)) {
      const e = document.createElement("div");
      e.className = "def-example";
      e.innerHTML = `<div class="en">${highlightHtml(ex.en || "", [def.word])}</div><div class="zh">${escapeHtml(ex.zh || "")}</div>`;
      wrap.appendChild(e);
    }
    card.appendChild(wrap);
  }

  const foot = document.createElement("div");
  foot.className = "def-foot";
  const alreadySaved = wbWordMap.has(String(def.word).toLowerCase());
  foot.innerHTML = `
    <span class="def-source">释义来源：${escapeHtml(def.source || "未知")}</span>
    <span class="spacer"></span>
    ${state.settings?.llm_key_set ? `<button class="btn btn-ghost btn-sm" data-act="ai">AI 释义</button>` : ""}
    ${
      alreadySaved
        ? `<button class="btn btn-sm btn-saved" data-act="save" disabled>✓ 已在生词本</button>`
        : `<button class="btn btn-primary btn-sm" data-act="save">＋ 生词本</button>`
    }`;
  card.appendChild(foot);

  foot.querySelector('[data-act="save"]').onclick = async (e) => {
    try {
      await api("/api/wordbook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          word: def.word,
          phonetic: def.phonetic,
          translation: def.translation,
          definition: def.definition,
        }),
      });
      e.target.textContent = "✓ 已加入";
      e.target.disabled = true;
      e.target.classList.remove("btn-primary");
      e.target.classList.add("btn-saved");
      refreshWordbookSilent();
      toast(`「${def.word}」已加入生词本`, "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  };

  const aiBtn = foot.querySelector('[data-act="ai"]');
  if (aiBtn) {
    aiBtn.onclick = async () => {
      aiBtn.disabled = true;
      aiBtn.textContent = "AI 生成中…";
      try {
        const { definition } = await api("/api/llm/define", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ word: def.word }),
        });
        // 同步会话缓存与当前结果：AI 释义已入服务端缓存，本地不更新的话同词重查会回退到旧释义
        if (state.lastResult?.definition?.word?.toLowerCase() === String(definition.word).toLowerCase()) {
          state.lastResult.definition = definition;
        }
        const cached = searchCache.get(`${state.examFilter}|${String(definition.word).toLowerCase()}`);
        if (cached?.definition?.word?.toLowerCase() === String(definition.word).toLowerCase()) {
          cached.definition = definition;
        }
        const fresh = buildDefCard(definition);
        card.replaceWith(fresh);
      } catch (err) {
        toast(err.message, "err");
        aiBtn.disabled = false;
        aiBtn.textContent = "AI 释义";
      }
    };
  }
  return card;
}

function buildSentenceCard(s, terms, index, queryWord) {
  const card = document.createElement("article");
  card.className = "sentence-card";
  card.style.animationDelay = `${Math.min(index * 40, 240)}ms`;
  // 该词已收录且挂的正是这条例句 → 直接显示完成态；收录了词但没这条例句仍可点，用于补挂例句
  const savedHere = wbWordMap.get(queryWord.toLowerCase())?.sentence_id === s.id;
  card.innerHTML = `
    <div class="sentence-text">${highlightHtml(s.text, terms)}</div>
    <div class="sentence-meta">
      <span class="sentence-source" title="${escapeHtml(s.filename)}">
        <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>
        ${escapeHtml(s.filename)}
      </span>
      <span class="${badgeClass(s.exam_type)}">${escapeHtml(s.exam_type)}</span>
      <span class="sentence-actions">
        <button class="link-btn" data-act="save-sentence" title="把单词和这条例句一起收进生词本">
          <svg viewBox="0 0 24 24"><path d="M14.43 10 12 4.73 9.57 10l-5.51.55 4.14 3.73-1.19 5.42L12 16.9l4.99 2.8-1.19-5.42 4.14-3.73L14.43 10z"/></svg>${savedHere ? "✓ 已收录" : "收录"}
        </button>
        <button class="link-btn" data-act="speak-sent" title="朗读例句">
          <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>朗读
        </button>
        <button class="link-btn" data-act="copy" title="复制例句">
          <svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>复制
        </button>
        <button class="link-btn" data-act="context">
          <svg viewBox="0 0 24 24"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>上下文
        </button>
        ${state.settings?.llm_key_set ? `<button class="link-btn" data-act="translate">译</button>` : ""}
      </span>
    </div>
    <div class="context-box" hidden></div>`;

  bindDblClickSearch(card.querySelector(".sentence-text"));
  if (savedHere) card.querySelector('[data-act="save-sentence"]').classList.add("is-on");

  card.querySelector('[data-act="speak-sent"]').onclick = () => speak(s.text);

  const copyBtn = card.querySelector('[data-act="copy"]');
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(s.text);
      toast("例句已复制", "ok");
    } catch {
      toast("复制失败：浏览器未授权剪贴板访问", "err");
    }
  };

  const saveBtn = card.querySelector('[data-act="save-sentence"]');
  saveBtn.onclick = async () => {
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    const def = state.lastResult?.definition;
    try {
      await api("/api/wordbook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          word: queryWord,
          phonetic: def?.word?.toLowerCase() === queryWord.toLowerCase() ? def.phonetic : "",
          translation: def?.word?.toLowerCase() === queryWord.toLowerCase() ? def.translation : "",
          definition: def?.word?.toLowerCase() === queryWord.toLowerCase() ? def.definition : "",
          sentence_id: s.id,
        }),
      });
      saveBtn.classList.add("is-on");
      saveBtn.innerHTML = `✓ 已收录`;
      const entry = wbWordMap.get(queryWord.toLowerCase());
      if (entry) entry.sentence_id = s.id; // 本地同步，避免重渲染后回退成未收录
      refreshWordbookSilent();
      toast(`「${queryWord}」连同这条例句已加入生词本`, "ok");
    } catch (err) {
      saveBtn.disabled = false;
      toast(err.message, "err");
    }
  };

  const ctxBox = card.querySelector(".context-box");
  bindDblClickSearch(ctxBox);
  const ctxBtn = card.querySelector('[data-act="context"]');
  ctxBtn.onclick = async () => {
    if (!ctxBox.hidden) {
      ctxBox.hidden = true;
      ctxBtn.classList.remove("is-on");
      return;
    }
    if (!ctxBox.dataset.loaded) {
      ctxBtn.classList.add("is-on");
      ctxBox.innerHTML = `<div class="skeleton-line" style="width:70%"></div>`;
      ctxBox.hidden = false;
      try {
        const data = await api(
          `/api/sentences/context?document_id=${s.document_id}&position=${s.position}&span=2`
        );
        ctxBox.innerHTML = data.sentences
          .map(
            (c) =>
              `<div class="context-line${c.rel === 0 ? " center" : ""}">${highlightHtml(c.text, terms)}</div>`
          )
          .join("");
        ctxBox.dataset.loaded = "1";
      } catch (err) {
        ctxBox.innerHTML = `<div class="context-line">加载失败：${escapeHtml(err.message)}</div>`;
      }
    } else {
      ctxBox.hidden = false;
      ctxBtn.classList.add("is-on");
    }
  };

  const trBtn = card.querySelector('[data-act="translate"]');
  if (trBtn) {
    trBtn.onclick = async () => {
      if (card.querySelector(".sentence-zh")) {
        card.querySelector(".sentence-zh").remove();
        trBtn.classList.remove("is-on");
        return;
      }
      trBtn.classList.add("is-on");
      const zh = document.createElement("div");
      zh.className = "sentence-zh";
      zh.textContent = "翻译中…";
      card.querySelector(".sentence-meta").after(zh);
      try {
        const data = await api("/api/llm/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: s.text }),
        });
        zh.textContent = data.zh;
      } catch (err) {
        zh.textContent = `翻译失败：${err.message}`;
      }
    };
  }

  return card;
}

// ---------------------------------------------------------------------------
// 查词联想：从自己真题的词表实时补全（/api/suggest），↑↓ 选择、回车查、Esc 收起
// ---------------------------------------------------------------------------

const suggestState = { items: [], active: -1, reqId: 0, open: false };
let suggestTimer = null;

function hideSuggest() {
  suggestState.open = false;
  suggestState.active = -1;
  $("#suggest-box").hidden = true;
}

function renderSuggest(items) {
  const box = $("#suggest-box");
  suggestState.items = items;
  suggestState.active = -1;
  if (!items.length) {
    hideSuggest();
    return;
  }
  box.innerHTML = items
    .map(
      (s, i) => `
      <button type="button" class="suggest-item" data-i="${i}">
        <span class="suggest-word">${escapeHtml(s.word)}</span>
        <span class="suggest-count">${s.cnt} 句</span>
      </button>`
    )
    .join("");
  box.querySelectorAll(".suggest-item").forEach((el) => {
    el.addEventListener("mousedown", (e) => e.preventDefault()); // 先压住输入框焦点，click 才能落到自己身上
    el.addEventListener("click", () => chooseSuggest(items[Number(el.dataset.i)].word));
  });
  suggestState.open = true;
  box.hidden = false;
}

function chooseSuggest(word) {
  hideSuggest();
  $("#search-input").value = word;
  doSearch(word, true);
}

function moveSuggestActive(delta) {
  if (!suggestState.open || !suggestState.items.length) return;
  const n = suggestState.items.length;
  let a = suggestState.active + delta;
  if (a < -1) a = n - 1;
  if (a >= n) a = -1;
  suggestState.active = a;
  $("#suggest-box").querySelectorAll(".suggest-item").forEach((el, i) => {
    el.classList.toggle("active", i === a);
    if (i === a) el.scrollIntoView({ block: "nearest" });
  });
}

async function fetchSuggestions(prefix) {
  const params = new URLSearchParams({ prefix });
  if (state.examFilter) params.set("exam_type", state.examFilter);
  const reqId = ++suggestState.reqId;
  try {
    const data = await api(`/api/suggest?${params}`);
    return reqId === suggestState.reqId ? data.suggestions || [] : null; // null = 已被更新的输入覆盖
  } catch {
    return null;
  }
}

function scheduleSuggest(value) {
  clearTimeout(suggestTimer);
  const v = value.trim().toLowerCase();
  if (v.length < 2 || !/^[a-z][a-z'-]+$/.test(v)) {
    hideSuggest(); // 短于 2 个字符或含空格（短语）不联想
    return;
  }
  suggestTimer = setTimeout(async () => {
    const items = await fetchSuggestions(v);
    if (items === null || $("#search-input").value.trim().toLowerCase() !== v) return;
    renderSuggest(items);
  }, 200);
}

// 搜索输入：输入即搜（防抖 450ms）+ 联想（防抖 200ms）
$("#search-input").addEventListener("input", (e) => {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => doSearch(e.target.value), 450);
  scheduleSuggest(e.target.value);
});
$("#search-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    moveSuggestActive(1);
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    moveSuggestActive(-1);
    return;
  }
  if (e.key === "Enter") {
    if (suggestState.open && suggestState.active >= 0) {
      e.preventDefault();
      chooseSuggest(suggestState.items[suggestState.active].word);
      return;
    }
    clearTimeout(state.debounceTimer);
    doSearch(e.target.value, true);
    return;
  }
  if (e.key === "Escape") {
    if (suggestState.open) {
      hideSuggest(); // 第一次 Esc 只收起联想，再按才清空
      return;
    }
    e.target.value = "";
    e.target.blur();
    clearTimeout(state.debounceTimer);
    searchSeq += 1; // 作废在途查询，防止欢迎页被迟到的旧结果顶掉
    state.currentWord = "";
    renderWelcome();
  }
});
$("#search-input").addEventListener("blur", () => setTimeout(hideSuggest, 120));
$("#search-btn").addEventListener("click", () => {
  clearTimeout(state.debounceTimer);
  doSearch($("#search-input").value, true);
});

// 快捷键：/ 或 Ctrl/Cmd+K 聚焦搜索框；搜索框内 Esc 清空并回到欢迎页（见上方 keydown）
document.addEventListener("keydown", (e) => {
  const authModeOn = document.body.classList.contains("auth-mode");
  const reviewOn = !$("#review-overlay").hidden;
  if (reviewOn) return; // 复习浮层有自己的快捷键处理
  if (e.key === "/" && !authModeOn && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) {
    e.preventDefault();
    document.querySelector('[data-tab="search"]')?.click();
    $("#search-input").focus();
    $("#search-input").select();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k" && !authModeOn) {
    e.preventDefault();
    document.querySelector('[data-tab="search"]')?.click();
    $("#search-input").focus();
    $("#search-input").select();
  }
});

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

const dropZone = $("#drop-zone");
const fileInput = $("#file-input");

dropZone.addEventListener("click", (e) => {
  if (!e.target.closest("button")) fileInput.click();
});
$("#pick-btn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  handleFiles([...fileInput.files]);
  fileInput.value = "";
});
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragging");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragging");
  handleFiles([...e.dataTransfer.files]);
});

function queueItem(name) {
  const el = document.createElement("div");
  el.className = "queue-item";
  el.innerHTML = `
    <span class="q-icon"><span class="spinner"></span></span>
    <span class="q-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
    <span class="q-status">排队中…</span>`;
  $("#import-queue").prepend(el);
  return {
    setStatus(text, kind = "") {
      const s = el.querySelector(".q-status");
      s.textContent = text;
      s.className = `q-status ${kind}`;
    },
    setProgress(ratio) {
      let bar = el.querySelector(".progress-bar");
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "progress-bar";
        bar.innerHTML = "<div></div>";
        el.appendChild(bar);
      }
      bar.firstElementChild.style.width = `${Math.round(ratio * 100)}%`;
    },
    done(text) {
      el.querySelector(".q-icon").innerHTML = `<span class="done">✓</span>`;
      this.setStatus(text, "ok");
    },
    fail(text) {
      el.querySelector(".q-icon").innerHTML = `<span class="fail">✕</span>`;
      this.setStatus(text, "err");
    },
  };
}

// 同名文档提醒：已存在同名文档时让用户确认（避免重复导入制造重复例句），返回 false 表示跳过
function confirmDuplicate(filename) {
  const name = String(filename || "").trim().toLowerCase();
  if (!name) return true;
  const hit = documentsCache.find((d) => String(d.filename || "").trim().toLowerCase() === name);
  if (!hit) return true;
  return confirm(
    `已导入过同名文档「${hit.filename}」（${hit.sentence_count} 句）。\n` +
      `再次导入会生成一份重复的文档与例句（查词时会重复出现），确定继续吗？`
  );
}

async function handleFiles(files) {
  if (!files.length) return;
  const examType = $("#exam-type").value;
  const ocrEnabled = $("#ocr-toggle").checked && state.settings?.mineru_token_set;

  for (const file of files) {
    const q = queueItem(file.name);
    if (!confirmDuplicate(file.name)) {
      q.fail("已跳过：同名文档已存在");
      continue;
    }
    try {
      const isPdf = file.name.toLowerCase().endsWith(".pdf");
      let text = "";
      let pages = 0;

      if (isPdf && ocrEnabled) {
        q.setStatus("MinerU OCR 解析中（约需 1–3 分钟）…");
        text = await mineruExtract(file);
      } else {
        q.setStatus("解析文本中…");
        const res = await extractAnyFile(file, (p, total) =>
          q.setStatus(`解析第 ${p}/${total} 页…`)
        );
        text = res.text;
        pages = res.pages;

        if (isPdf && looksLikeScanned(res)) {
          if (state.settings?.mineru_token_set) {
            q.setStatus("文本太少，疑似扫描件 → 转 MinerU OCR…");
            text = await mineruExtract(file);
          } else {
            q.setStatus("文本很少，可能是扫描件；到「设置」配置 MinerU 后可用 OCR");
          }
        }
      }

      const sentences = buildSentencesPayload(text);
      if (!sentences.length) {
        q.fail("未解析出任何句子");
        continue;
      }
      try {
        const docId = await createDocumentWithSentences(file.name, examType, sentences, (msg) => q.setStatus(msg), (r) => q.setProgress(r));
        // 立刻登记进缓存：同批次里再有同名文件时 confirmDuplicate 才拦得住
        //（loadDocuments 要等整批结束才刷新，中途 documentsCache 还是旧的）
        documentsCache.push({ id: docId, filename: file.name, sentence_count: sentences.length });
        q.done(`导入完成：${sentences.length} 句`);
      } catch (err) {
        q.fail(err.message);
      }
    } catch (err) {
      q.fail(err.message);
    }
  }
  searchCache.clear(); // 新文档入库，旧查询缓存作废
  await loadDocuments();
  toast("导入批次处理完毕", "ok");
}

// 分块上传句子索引到已有文档（新建文档与追加导入共用）
async function uploadSentences(docId, sentences, setStatus, onProgress) {
  for (let i = 0; i < sentences.length; i += UPLOAD_CHUNK) {
    const chunk = sentences.slice(i, i + UPLOAD_CHUNK);
    setStatus?.(`建索引 ${Math.min(i + chunk.length, sentences.length)}/${sentences.length} 句…`);
    await api(`/api/documents/${docId}/sentences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentences: chunk }),
    });
    onProgress?.(Math.min(i + chunk.length, sentences.length) / sentences.length);
  }
}

// 建文档 + 分块上传句子索引（文件导入与粘贴导入共用）
async function createDocumentWithSentences(filename, examType, sentences, setStatus, onProgress) {
  setStatus?.("创建文档…");
  const doc = await api("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, exam_type: examType }),
  });
  await uploadSentences(doc.id, sentences, setStatus, onProgress);
  return doc.id;
}

// ---------------------------------------------------------------------------
// 粘贴文本导入
// ---------------------------------------------------------------------------

// 粘贴表单「追加到已有文档」下拉：展开时与文档列表变化后重建选项
function refreshPasteTargets() {
  const sel = $("#paste-target");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML =
    `<option value="">新建文档</option>` +
    documentsCache
      .map((d) => `<option value="${d.id}">${escapeHtml(d.filename)}（${d.sentence_count} 句）</option>`)
      .join("");
  // 尽量保留之前的选择；文档已删则回落到新建
  sel.value = documentsCache.some((d) => String(d.id) === prev) ? prev : "";
  $("#paste-target-field").hidden = !documentsCache.length;
  $("#paste-title-field").hidden = Boolean(sel.value); // 追加模式下标题无用
}

$("#paste-toggle").addEventListener("click", () => {
  const form = $("#paste-form");
  form.hidden = !form.hidden;
  if (!form.hidden) {
    refreshPasteTargets();
    $("#paste-text").focus();
  }
});

$("#paste-target").addEventListener("change", () => {
  $("#paste-title-field").hidden = Boolean($("#paste-target").value);
});

let pasteStatsTimer = null;
$("#paste-text").addEventListener("input", () => {
  // 统计要做完整分句+分词，大文本每次击键全量解析会卡输入，防抖 300ms
  clearTimeout(pasteStatsTimer);
  pasteStatsTimer = setTimeout(() => {
    const text = $("#paste-text").value;
    if (!text.trim()) {
      $("#paste-stats").textContent = "";
      return;
    }
    $("#paste-stats").textContent = `${text.length.toLocaleString()} 字符 · 约 ${buildSentencesPayload(text).length} 句`;
  }, 300);
});

$("#paste-import").addEventListener("click", async () => {
  const btn = $("#paste-import");
  const text = $("#paste-text").value;
  if (!text.trim()) return toast("正文是空的，先把真题原文粘进来", "err");
  const targetId = Number($("#paste-target").value) || 0;
  const targetDoc = targetId ? documentsCache.find((d) => d.id === targetId) : null;
  const title =
    targetDoc?.filename || $("#paste-title").value.trim() || `粘贴文本 ${new Date().toISOString().slice(0, 10)}`;
  if (!targetDoc && !confirmDuplicate(title)) return toast("已取消：同名文档已存在");
  btn.disabled = true;
  try {
    const sentences = buildSentencesPayload(text);
    if (!sentences.length) throw new Error("未能从文本中解析出句子");
    if (targetDoc) {
      // 追加模式：句子接在所选文档已有索引后面（不新建文档）
      await uploadSentences(targetId, sentences, (msg) => ($("#paste-stats").textContent = msg));
    } else {
      await createDocumentWithSentences(
        title.slice(0, 255),
        $("#exam-type").value,
        sentences,
        (msg) => ($("#paste-stats").textContent = msg)
      );
    }
    searchCache.clear();
    await loadDocuments();
    $("#paste-text").value = "";
    $("#paste-title").value = "";
    $("#paste-stats").textContent = "";
    $("#paste-form").hidden = true;
    toast(
      targetDoc
        ? `已追加 ${sentences.length} 句到「${targetDoc.filename}」`
        : `「${title}」导入完成：${sentences.length} 句`,
      "ok"
    );
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.disabled = false;
  }
});

// 扫描版 PDF → MinerU：申请上传地址 → 上传 → 轮询 → 下载 zip → 取 .md
async function mineruExtract(file) {
  const { batchId, fileUrls } = await api("/api/mineru/upload-urls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: [{ name: file.name }] }),
  });
  if (!fileUrls?.length) throw new Error("MinerU 未返回上传地址");
  const up = await api(`/api/mineru/upload?url=${encodeURIComponent(fileUrls[0])}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: file,
  });
  if (!up.ok) throw new Error(`MinerU 文件上传失败（HTTP ${up.status}）`);

  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    let data;
    try {
      data = await api(`/api/mineru/batch/${batchId}`);
    } catch (e) {
      // 轮询途中的瞬时网络抖动不该让整次已上传的 OCR 任务作废，吞掉重试
      if (String(e.message || "").startsWith("网络请求失败")) continue;
      throw e;
    }
    const item = data.extract_result?.[0];
    if (!item) continue;
    if (item.state === "done" && item.full_zip_url) {
      const resp = await fetch(`/api/mineru/download?url=${encodeURIComponent(item.full_zip_url)}`);
      if (!resp.ok) throw new Error(`MinerU 结果下载失败（HTTP ${resp.status}）`);
      return unzipMarkdown(await resp.arrayBuffer());
    }
    if (item.state === "failed") throw new Error(`MinerU 解析失败：${item.err_msg || "未知错误"}`);
  }
  throw new Error("MinerU 解析超时（8 分钟），可稍后重试");
}

let documentsCache = []; // 同名导入去重提醒用

async function loadDocuments() {
  try {
    const data = await api("/api/documents");
    const docs = data.documents || [];
    documentsCache = docs;
    refreshPasteTargets(); // 文档列表变化后同步「追加到文档」下拉
    const total = docs.reduce((s, d) => s + (d.sentence_count || 0), 0);
    $("#doc-count").textContent = docs.length ? `${docs.length} 份 · 共 ${total} 句` : "";
    const list = $("#doc-list");
    list.innerHTML = "";
    if (!docs.length) {
      list.innerHTML = `<div class="doc-empty">还没有导入真题。先丢一份进来试试。</div>`;
      return;
    }
    for (const d of docs) {
      const el = document.createElement("div");
      el.className = "doc-item";
      el.innerHTML = `
        <div class="doc-info">
          <div class="doc-name" title="${escapeHtml(d.filename)}">${escapeHtml(d.filename)}</div>
          <div class="doc-meta">
            <span>${d.sentence_count} 句</span>
            <span>导入于 ${escapeHtml(fmtDate(d.imported_at))}</span>
          </div>
        </div>
        <span class="${badgeClass(d.exam_type)}">${escapeHtml(d.exam_type)}</span>
        <div class="doc-actions">
          <button class="btn btn-ghost btn-sm" data-act="view" title="浏览本文档的句子，或在其中搜索">查看</button>
          <button class="btn btn-ghost btn-sm" data-act="rename" title="修改文档名">重命名</button>
          <button class="btn btn-danger btn-sm">删除</button>
        </div>
        <div class="doc-preview" hidden></div>`;

      const preview = el.querySelector(".doc-preview");
      const viewBtn = el.querySelector('[data-act="view"]');
      viewBtn.onclick = () => {
        if (preview.hidden) {
          preview.hidden = false;
          viewBtn.classList.add("is-on");
          viewBtn.textContent = "收起";
          if (!preview.dataset.loaded) {
            preview.innerHTML = `
              <div class="dp-search">
                <input type="text" class="dp-q" placeholder="在本文档中搜索句子…" autocomplete="off">
                <button class="btn btn-ghost btn-sm" data-act="dp-search">搜索</button>
                <span class="dp-count muted"></span>
              </div>
              <div class="dp-list"></div>`;
            const qInput = preview.querySelector(".dp-q");
            const runSearch = () => loadDocPreview(d, preview, qInput.value.trim());
            preview.querySelector('[data-act="dp-search"]').onclick = runSearch;
            qInput.addEventListener("keydown", (e) => {
              if (e.key === "Enter") runSearch();
            });
            loadDocPreview(d, preview, "");
          }
        } else {
          preview.hidden = true;
          viewBtn.classList.remove("is-on");
          viewBtn.textContent = "查看";
        }
      };

      // 行内重命名：文档名原地变成输入框（Enter 保存 / Esc 取消），比弹窗顺手
      el.querySelector('[data-act="rename"]').onclick = () => {
        const nameEl = el.querySelector(".doc-name");
        if (el.querySelector(".doc-rename")) return;
        const input = document.createElement("input");
        input.className = "doc-rename";
        input.value = d.filename;
        input.maxLength = 255;
        const save = document.createElement("button");
        save.className = "btn btn-ghost btn-sm";
        save.textContent = "保存";
        const cancel = document.createElement("button");
        cancel.className = "btn btn-ghost btn-sm";
        cancel.textContent = "取消";
        const bar = document.createElement("div");
        bar.className = "doc-rename-bar";
        bar.append(input, save, cancel);
        nameEl.replaceWith(bar);
        input.focus();
        input.select();
        const finish = () => bar.replaceWith(nameEl);
        const submit = async () => {
          const trimmed = input.value.trim();
          if (!trimmed) {
            toast("文档名不能为空", "err");
            input.focus();
            return;
          }
          if (trimmed === d.filename) return finish();
          try {
            await api(`/api/documents/${d.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filename: trimmed }),
            });
            toast("已重命名", "ok");
            loadDocuments();
          } catch (err) {
            toast(err.message, "err");
            input.focus();
          }
        };
        save.onclick = submit;
        cancel.onclick = finish;
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") submit();
          else if (e.key === "Escape") finish();
        });
      };

      el.querySelector(".btn-danger").onclick = async () => {
        if (!confirm(`删除「${d.filename}」？其全部句子与索引将一并清除。`)) return;
        try {
          await api(`/api/documents/${d.id}`, { method: "DELETE" });
          searchCache.clear(); // 与导入路径对齐：别让已删文档的例句从缓存里“复活”
          toast("已删除", "ok");
          loadDocuments();
        } catch (err) {
          toast(err.message, "err");
        }
      };
      list.appendChild(el);
    }
  } catch (e) {
    $("#doc-list").innerHTML = `<div class="doc-empty">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

// 文档预览面板：句子列表 + 文档内搜索（双击句中单词直接查词），支持「加载更多」翻页
const DP_PAGE = 50;

async function loadDocPreview(doc, panel, q, append = false) {
  // 面板级序号守卫：连续搜索/翻页时只认最后一次请求，防止旧响应覆盖或混入新结果
  //（多份文档的预览面板可同时展开，序号挂在 panel 上互不干扰）
  const seq = (Number(panel.dataset.seq) || 0) + 1;
  panel.dataset.seq = String(seq);
  const listEl = panel.querySelector(".dp-list") || panel;
  const offset = append ? panel.querySelectorAll(".dp-line").length : 0;
  if (!append) listEl.innerHTML = `<div class="dp-status">加载中…</div>`;
  panel.querySelector('[data-act="dp-more"]')?.remove();
  try {
    const params = new URLSearchParams({ limit: DP_PAGE, offset });
    if (q) params.set("q", q);
    const data = await api(`/api/documents/${doc.id}/sentences?${params}`);
    if (seq !== Number(panel.dataset.seq)) return; // 过期响应，丢弃
    panel.dataset.loaded = "1";
    panel.dataset.q = q || "";
    const count = panel.querySelector(".dp-count");
    if (count) {
      const shown = offset + data.sentences.length;
      count.textContent = q
        ? `命中 ${data.total} 句${data.total > shown ? `，已显示 ${shown} 句` : ""}`
        : `共 ${data.total} 句${data.total > shown ? `，已显示 ${shown} 句` : ""}`;
    }
    if (!offset && !data.sentences.length) {
      listEl.innerHTML = `<div class="dp-status">没有匹配的句子</div>`;
      return;
    }
    listEl.insertAdjacentHTML(
      "beforeend",
      data.sentences.map((s) => `<div class="dp-line" data-pos="${s.position}">${qmark(s.text, q)}</div>`).join("")
    );
    bindDblClickSearch(listEl);
    if (offset + data.sentences.length < data.total) {
      const more = document.createElement("button");
      more.className = "btn btn-ghost btn-sm dp-more";
      more.dataset.act = "dp-more";
      more.textContent = `加载更多（还有 ${data.total - offset - data.sentences.length} 句）`;
      more.onclick = () => {
        more.disabled = true;
        more.textContent = "加载中…";
        loadDocPreview(doc, panel, q, true);
      };
      listEl.after(more);
    }
  } catch (err) {
    if (!append) listEl.innerHTML = `<div class="dp-status">加载失败：${escapeHtml(err.message)}</div>`;
  }
}

// 预览句子高亮搜索词（先转义再包裹，避免注入）
function qmark(text, q) {
  const escaped = escapeHtml(text);
  if (!q) return escaped;
  const re = new RegExp(escapeRegExp(escapeHtml(q)), "gi");
  return escaped.replace(re, "<mark>$&</mark>");
}

// OCR 开关可用性提示
function refreshOcrHint() {
  const hint = $("#ocr-hint");
  if (state.settings?.mineru_token_set) {
    hint.textContent = "✓ 已配置 MinerU Token";
    hint.className = "option-hint ok";
  } else {
    hint.textContent = "未配置 MinerU Token，可在「设置」页配置";
    hint.className = "option-hint";
  }
}

// ---------------------------------------------------------------------------
// 生词本
// ---------------------------------------------------------------------------

let wordbookCache = [];
let wbWordMap = new Map(); // word(小写) → 生词本条目：查词页判断「已加入 / 已收录」用

function rebuildWbSets() {
  wbWordMap = new Map(wordbookCache.map((w) => [String(w.word).toLowerCase(), w]));
}

// 静默刷新生词本缓存：收录新词后让「已加入」状态与复习池保持最新，不动 UI
async function refreshWordbookSilent() {
  try {
    const data = await api("/api/wordbook");
    wordbookCache = data.words || [];
    rebuildWbSets();
    updateDueBadge();
  } catch {}
}

// ---------------------------------------------------------------------------
// SRS 到期调度：next_review_at（客户端本地时间）驱动「今日待复习」
// 间隔按评分后的熟悉度走：认识 → 逐级拉长（2/4/8/16/32 天封顶）；
// 忘记 / 模糊 → 明天再见。'' 表示从未调度（新词、历史存量），视为立即到期。
// ---------------------------------------------------------------------------

const SRS_INTERVALS = [2, 4, 8, 16, 32, 32]; // 索引 = 评分后的 familiarity

function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 下次复习时间：days 天后的本地日期（时分秒取中午，避免跨日边界歧义）
function nextReviewAtStr(days) {
  return `${localDateStr(new Date(Date.now() + days * 86400000))} 12:00:00`;
}

function isDueWord(w) {
  const n = String(w.next_review_at || "");
  return !n || n.slice(0, 10) <= localDateStr();
}

function computeDueCount() {
  return wordbookCache.filter(isDueWord).length;
}

// 顶栏「生词本」徽标 + 开始复习按钮上的今日到期数 + 欢迎页直达 CTA
function updateDueBadge() {
  const n = computeDueCount();
  const badge = $("#tab-wb-badge");
  if (badge) {
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.hidden = n === 0;
  }
  const btn = $("#review-btn");
  if (btn) btn.textContent = n > 0 ? `开始复习（今日 ${n}）` : "开始复习";
  updateWelcomeCta();
}

// 熟悉度分档：生疏 0-2 / 一般 3-4 / 熟练 5（筛选偏好记入 localStorage）
const WB_FAM_KEY = "iv_wb_fam";
const WB_SORT_KEY = "iv_wb_sort";
let wbFamFilter = "all";
let wbSort = "added";
try {
  wbFamFilter = ["all", "weak", "mid", "strong"].includes(localStorage.getItem(WB_FAM_KEY)) ? localStorage.getItem(WB_FAM_KEY) : "all";
  wbSort = ["added", "familiarity", "alpha"].includes(localStorage.getItem(WB_SORT_KEY)) ? localStorage.getItem(WB_SORT_KEY) : "added";
} catch {}

function famBand(f) {
  return f >= 5 ? "strong" : f >= 3 ? "mid" : "weak";
}

// 生词本顶部统计：总数 / 生疏 / 熟练 / 今日待复习 / 今日已复习
function renderWbStats() {
  const el = $("#wb-stats");
  updateDueBadge();
  if (!wordbookCache.length) {
    el.hidden = true;
    return;
  }
  const d = new Date();
  const localToday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const utcToday = d.toISOString().slice(0, 10); // last_reviewed_at 是 UTC，本地时区晚间复习要按本地日期算
  let weak = 0;
  let strong = 0;
  let todayN = 0;
  for (const w of wordbookCache) {
    const f = Math.max(0, Math.min(5, Number(w.familiarity) || 0));
    if (f <= 2) weak += 1;
    if (f >= 5) strong += 1;
    const reviewedOn = String(w.last_reviewed_at || "").slice(0, 10);
    if (reviewedOn === localToday || reviewedOn === utcToday) todayN += 1;
  }
  el.textContent = `共 ${wordbookCache.length} 词 · 生疏 ${weak} · 熟练 ${strong} · 今日待复习 ${computeDueCount()} · 今日已复习 ${todayN}`;
  el.hidden = false;
}

function renderFamChips() {
  renderWbStats();
  const counts = { all: wordbookCache.length, weak: 0, mid: 0, strong: 0 };
  for (const w of wordbookCache) {
    counts[famBand(Math.max(0, Math.min(5, Number(w.familiarity) || 0)))] += 1;
  }
  const defs = [
    ["all", "全部"],
    ["weak", "生疏"],
    ["mid", "一般"],
    ["strong", "熟练"],
  ];
  const box = $("#wb-fam-chips");
  box.innerHTML = "";
  for (const [key, label] of defs) {
    const b = document.createElement("button");
    b.className = "chip" + (wbFamFilter === key ? " active" : "");
    b.textContent = `${label} ${counts[key]}`;
    b.onclick = () => {
      wbFamFilter = key;
      try {
        localStorage.setItem(WB_FAM_KEY, key);
      } catch {}
      renderFamChips();
      renderWordbookGrid();
    };
    box.appendChild(b);
  }
}

const WB_SORTERS = {
  added: (a, b) => String(b.added_at || "").localeCompare(String(a.added_at || "")),
  familiarity: (a, b) =>
    (Number(a.familiarity) || 0) - (Number(b.familiarity) || 0) ||
    String(a.last_reviewed_at || "").localeCompare(String(b.last_reviewed_at || "")) ||
    String(a.added_at || "").localeCompare(String(b.added_at || "")),
  alpha: (a, b) => String(a.word).localeCompare(String(b.word)),
};

function famDotsHtml(familiarity) {
  const f = Math.max(0, Math.min(5, Number(familiarity) || 0));
  return `<span class="fam-dots" title="熟悉度 ${f}/5">${Array.from(
    { length: 5 },
    (_, i) => `<i class="${i < f ? "on" : ""}"></i>`
  ).join("")}</span>`;
}

// 筛选 + 排序后的生词列表（网格渲染与批量全选共用同一套过滤口径）
function filteredWordbookWords() {
  const q = ($("#wb-filter").value || "").trim().toLowerCase();
  let words = wordbookCache;
  if (wbFamFilter !== "all") {
    words = words.filter((w) => famBand(Math.max(0, Math.min(5, Number(w.familiarity) || 0))) === wbFamFilter);
  }
  if (q) {
    words = words.filter(
      (w) =>
        w.word.toLowerCase().includes(q) ||
        (w.translation || "").toLowerCase().includes(q) ||
        (w.source_file || "").toLowerCase().includes(q)
    );
  }
  return [...words].sort(WB_SORTERS[wbSort] || WB_SORTERS.added);
}

function renderWordbookGrid() {
  const grid = $("#wordbook-grid");
  const words = filteredWordbookWords();

  grid.innerHTML = "";
  $("#wb-toolbar").hidden = wordbookCache.length === 0;

  if (!wordbookCache.length) {
    grid.innerHTML = `<div class="doc-empty" style="grid-column:1/-1">生词本还是空的。查词时点「＋ 生词本」或在例句上点「收录」，把重要单词收进来。</div>`;
    return;
  }
  if (!words.length) {
    grid.innerHTML = `<div class="doc-empty" style="grid-column:1/-1">当前筛选条件下没有生词。</div>`;
    return;
  }
  for (const w of words) {
    const card = document.createElement("div");
    card.className = "wb-card";
    // 到期标签：已调度且未到期 → 显示未来复习日；已到期 → 高亮提醒；从未调度不显示
    const nextDay = String(w.next_review_at || "").slice(0, 10);
    const dueTag = nextDay
      ? nextDay <= localDateStr()
        ? `<span class="wb-due due-now" title="按 SRS 计划今天应复习">今日到期</span>`
        : `<span class="wb-due" title="SRS 计划的下次复习日">${escapeHtml(nextDay.slice(5))} 复习</span>`
      : "";
    card.innerHTML = `
      <div class="wb-head">
        <span class="wb-word" title="点击查这个词">${escapeHtml(w.word)}</span>
        <button class="icon-btn" title="朗读" data-act="speak">
          <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
        </button>
      </div>
      ${w.phonetic ? `<div class="wb-phonetic">${escapeHtml(w.phonetic)}</div>` : ""}
      ${w.translation ? `<div class="wb-translation">${escapeHtml(w.translation)}</div>` : ""}
      ${
        w.sentence_text
          ? `<div class="wb-sentence" title="点击查这个词">${escapeHtml(w.sentence_text)}</div>
             <div class="wb-foot"><span class="wb-date">${dueTag}来自 ${escapeHtml(w.source_file || "")} · ${escapeHtml(fmtDate(w.added_at))}</span>
             <button class="link-btn" data-act="del">移除</button></div>`
          : `<div class="wb-foot"><span class="wb-date">${dueTag}${escapeHtml(fmtDate(w.added_at))}</span>
             <button class="link-btn" data-act="del">移除</button></div>`
      }
      ${famDotsHtml(w.familiarity)}`;
    card.querySelector('[data-act="speak"]').onclick = () => speak(w.word);
    card.querySelector('[data-act="del"]').onclick = async () => {
      try {
        await api(`/api/wordbook/${w.id}`, { method: "DELETE" });
        toast(`已移除「${w.word}」`, "ok");
        loadWordbook();
      } catch (err) {
        toast(err.message, "err");
      }
    };
    // 点单词（或例句）直接查词
    const gotoSearch = () => {
      document.querySelector('[data-tab="search"]').click();
      $("#search-input").value = w.word;
      doSearch(w.word, true);
    };
    card.querySelector(".wb-word").onclick = gotoSearch;
    const sent = card.querySelector(".wb-sentence");
    if (sent) sent.onclick = gotoSearch;
    // 批量管理模式：卡片左上角出现勾选框
    if (wbBatch.on) {
      const check = document.createElement("label");
      check.className = "wb-check";
      check.innerHTML = `<input type="checkbox" ${wbBatch.ids.has(w.id) ? "checked" : ""} title="选中该生词">`;
      const box = check.querySelector("input");
      box.addEventListener("change", () => {
        if (box.checked) wbBatch.ids.add(w.id);
        else wbBatch.ids.delete(w.id);
        updateBatchBar();
      });
      card.appendChild(check);
    }
    grid.appendChild(card);
  }
}

async function loadWordbook() {
  const grid = $("#wordbook-grid");
  try {
    const data = await api("/api/wordbook");
    wordbookCache = data.words || [];
    rebuildWbSets();
    $("#wb-filter").value = "";
    $("#wb-sort").value = wbSort;
    renderFamChips();
    renderWordbookGrid();
  } catch (e) {
    $("#wb-toolbar").hidden = false;
    grid.innerHTML = `<div class="doc-empty" style="grid-column:1/-1">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

$("#wb-filter").addEventListener("input", renderWordbookGrid);

$("#wb-sort").addEventListener("change", () => {
  wbSort = $("#wb-sort").value;
  try {
    localStorage.setItem(WB_SORT_KEY, wbSort);
  } catch {}
  renderWordbookGrid();
});

// ---------------------------------------------------------------------------
// 生词本批量操作：批量删除 / 批量设置熟悉度（勾选框只出现在批量管理模式）
// ---------------------------------------------------------------------------

const wbBatch = { on: false, ids: new Set() };

$("#wb-batch-toggle").addEventListener("click", () => setBatchMode(!wbBatch.on));
$("#wb-batch-exit").addEventListener("click", () => setBatchMode(false));

function setBatchMode(on) {
  wbBatch.on = on;
  if (!on) wbBatch.ids.clear();
  $("#wb-batch-bar").hidden = !on;
  $("#wb-batch-toggle").classList.toggle("is-on", on);
  $("#wb-batch-all").checked = false;
  updateBatchBar();
  renderWordbookGrid(); // 重新渲染让勾选框出现/消失
}

function updateBatchBar() {
  $("#wb-batch-count").textContent = `已选 ${wbBatch.ids.size}`;
  const allBox = $("#wb-batch-all");
  const visible = filteredWordbookWords();
  const selectedVisible = visible.filter((w) => wbBatch.ids.has(w.id)).length;
  allBox.checked = visible.length > 0 && selectedVisible === visible.length;
  allBox.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
}

$("#wb-batch-all").addEventListener("change", (e) => {
  if (e.target.checked) filteredWordbookWords().forEach((w) => wbBatch.ids.add(w.id));
  else wbBatch.ids.clear();
  renderWordbookGrid();
  updateBatchBar();
});

document.querySelectorAll("#wb-batch-bar [data-bfam]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!wbBatch.ids.size) return toast("先勾选要操作的生词");
    runBatch({ action: "familiarity", familiarity: Number(btn.dataset.bfam) }, `已把 ${wbBatch.ids.size} 个生词熟悉度批量调整`);
  });
});

$("#wb-batch-del").addEventListener("click", () => {
  if (!wbBatch.ids.size) return toast("先勾选要删除的生词");
  if (!confirm(`确定删除所选 ${wbBatch.ids.size} 个生词？此操作不可撤销。`)) return;
  runBatch({ action: "delete" }, `已删除 ${wbBatch.ids.size} 个生词`);
});

async function runBatch(body, okMsg) {
  const ids = [...wbBatch.ids];
  try {
    await api("/api/wordbook/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, ids }),
    });
    toast(okMsg, "ok");
    wbBatch.ids.clear();
    $("#wb-batch-all").checked = false;
    await refreshWordbookSilent();
    renderFamChips();
    renderWordbookGrid();
    updateBatchBar();
    refreshStudyStats();
  } catch (err) {
    toast(err.message, "err");
  }
}

// ---------------------------------------------------------------------------
// 复习模式：全屏闪卡（SRS-lite，熟悉度 0-5）
// 忘记 → 熟悉度 -1；模糊 → 不变；认识 → +1。本轮队列：越不熟越先出。
// ---------------------------------------------------------------------------

const review = {
  open: false,
  queue: [],
  idx: 0,
  total: 0,
  revealed: false,
  done: false,
  grading: false, // 评分请求在途标志：连按 1/2/3 不会双写评分或跳卡
  mode: "word", // word = 看词回忆；cloze = 例句填空
  stats: { know: 0, fuzzy: 0, forget: 0 },
};

const REVIEW_SCOPE_KEY = "iv_review_scope";
const REVIEW_MODE_KEY = "iv_review_mode";
try {
  const saved = localStorage.getItem(REVIEW_SCOPE_KEY);
  if (saved === "all" || saved === "due" || saved === "weak") $("#review-scope").value = saved;
  const savedMode = localStorage.getItem(REVIEW_MODE_KEY);
  if (savedMode === "word" || savedMode === "cloze" || savedMode === "reverse") $("#review-mode").value = savedMode;
} catch {}

$("#review-mode").addEventListener("change", () => {
  try {
    localStorage.setItem(REVIEW_MODE_KEY, $("#review-mode").value);
  } catch {}
});

function startReview() {
  if (!wordbookCache.length) return toast("生词本是空的，先去查几个词收进来");
  // 复习范围：到期词（按 SRS 计划今天该复习的）/ 生疏词（熟悉度 ≤ 3）/ 全部
  const scopeSel = $("#review-scope").value;
  const scope = scopeSel === "weak" ? "weak" : scopeSel === "due" ? "due" : "all";
  try {
    localStorage.setItem(REVIEW_SCOPE_KEY, scope);
  } catch {}
  let pool = wordbookCache;
  if (scope === "weak") pool = pool.filter((w) => (Number(w.familiarity) || 0) <= 3);
  if (scope === "due") pool = pool.filter(isDueWord);
  if (!pool.length) {
    return toast(
      scope === "weak"
        ? "没有生疏词（熟悉度 ≤ 3）需要复习，换个范围试试"
        : scope === "due"
          ? "今天没有到期的生词，明天再来吧"
          : "生词本是空的"
    );
  }
  // 排序：到期的（含新词）排前面；同组内熟悉度低在前、最近没复习的在前、再按加入时间
  review.queue = [...pool].sort((a, b) => {
    const da = isDueWord(a) ? 0 : 1;
    const db = isDueWord(b) ? 0 : 1;
    if (da !== db) return da - db;
    const fa = a.familiarity || 0;
    const fb = b.familiarity || 0;
    if (fa !== fb) return fa - fb;
    const ra = a.last_reviewed_at || "";
    const rb = b.last_reviewed_at || "";
    if (ra !== rb) return ra.localeCompare(rb);
    return String(a.added_at || "").localeCompare(String(b.added_at || ""));
  });
  review.idx = 0;
  review.total = review.queue.length;
  review.done = false;
  review.mode = ["cloze", "reverse"].includes($("#review-mode").value) ? $("#review-mode").value : "word";
  review.stats = { know: 0, fuzzy: 0, forget: 0 };
  review.open = true;
  $("#review-overlay").hidden = false;
  $("#review-summary").hidden = true;
  $("#review-card").hidden = false;
  $("#review-grade").hidden = true;
  renderReviewCard();
}

// 例句填空：把目标词及其同干变体（running / runs…）挖成空格
function clozeHtml(sentence, word) {
  const terms = collectHighlightTerms(word, [{ text: sentence }], false);
  const escaped = escapeHtml(sentence);
  const valid = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!valid.length) return escaped;
  const re = new RegExp(`\\b(${valid.map((t) => escapeRegExp(escapeHtml(t))).join("|")})\\b`, "gi");
  return escaped.replace(re, '<span class="cloze-blank"></span>');
}

function renderReviewCard() {
  const w = review.queue[review.idx];
  review.revealed = false;
  $("#review-progress").textContent = `${review.idx + 1} / ${review.total}`;
  $("#review-bar-fill").style.width = `${Math.round((review.idx / review.total) * 100)}%`;
  const useCloze = review.mode === "cloze" && Boolean(w.sentence_text);
  // 看义忆词：释义先行露出，翻面才给单词；没有任何释义的词退回看词模式
  const useReverse = review.mode === "reverse" && Boolean(w.translation || w.definition);
  const clozeEl = $("#review-cloze");
  const hintBtn = $("#review-cloze-hint");
  const ansEl = $("#review-answer");
  if (useCloze) {
    $("#review-word-row").hidden = true;
    clozeEl.innerHTML = clozeHtml(w.sentence_text, w.word);
    clozeEl.hidden = false;
    $("#review-hint").textContent = "回想空格处的单词，然后按空格或点击卡片显示答案";
    ansEl.hidden = true;
  } else if (useReverse) {
    $("#review-word-row").hidden = true;
    clozeEl.hidden = true;
    // 提示区（#review-answer）提前可见，但只给释义；音标和例句翻面才出现
    $("#review-translation").textContent = w.translation || "";
    $("#review-translation").hidden = !w.translation;
    $("#review-definition").textContent = w.definition || "";
    $("#review-definition").hidden = !w.definition;
    $("#review-phonetic").hidden = true;
    $("#review-sentence").hidden = true;
    ansEl.hidden = false;
    $("#review-hint").textContent = "看释义回想对应的英文单词，然后按空格显示答案";
  } else {
    $("#review-word-row").hidden = false;
    clozeEl.hidden = true;
    $("#review-word").textContent = w.word;
    $("#review-hint").textContent = "回想释义，然后按空格或点击卡片显示答案";
    ansEl.hidden = true;
  }
  // 填空/看义忆词有提示价值才亮出「想不起来？给我提示」（每张卡重新来）
  hintBtn.hidden = !(useCloze || useReverse);
  $("#review-grade").hidden = true;
}

function revealReviewCard() {
  if (review.revealed || review.done) return;
  const w = review.queue[review.idx];
  review.revealed = true;
  $("#review-hint").hidden = true;
  $("#review-cloze-hint").hidden = true; // 答案已揭晓，提示按钮没意义了，一并收起
  $("#review-word-row").hidden = false;
  $("#review-word").textContent = w.word;
  $("#review-cloze").hidden = true;
  $("#review-phonetic").textContent = w.phonetic || "";
  $("#review-phonetic").hidden = !w.phonetic;
  $("#review-translation").textContent = w.translation || "";
  $("#review-translation").hidden = !w.translation;
  $("#review-definition").textContent = w.definition || "";
  $("#review-definition").hidden = !w.definition;
  const sentEl = $("#review-sentence");
  if (w.sentence_text) {
    sentEl.innerHTML = highlightHtml(w.sentence_text, collectHighlightTerms(w.word, [{ text: w.sentence_text }], false));
    sentEl.hidden = false;
  } else {
    sentEl.hidden = true;
  }
  $("#review-answer").hidden = false;
  $("#review-grade").hidden = false;
}

async function gradeReviewCard(kind) {
  if (!review.revealed || review.done || review.grading) return;
  const w = review.queue[review.idx];
  const oldF = Math.max(0, Math.min(5, Number(w.familiarity) || 0));
  const newF = kind === "forget" ? Math.max(0, oldF - 1) : kind === "know" ? Math.min(5, oldF + 1) : oldF;
  // SRS 调度：认识 → 按新熟悉度拉长间隔；忘记/模糊 → 明天再见
  const nextAt = nextReviewAtStr(kind === "know" ? SRS_INTERVALS[newF] : 1);
  review.grading = true;
  try {
    await api("/api/wordbook/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: w.id,
        familiarity: newF,
        graded_as: kind,
        next_review_at: nextAt,
        review_date: localDateStr(),
      }),
    });
  } catch (err) {
    toast(err.message, "err");
    return; // 保存失败停在本卡，用户可重试
  } finally {
    review.grading = false;
  }
  w.familiarity = newF;
  w.next_review_at = nextAt;
  w.last_reviewed_at = new Date().toISOString().replace("T", " ").slice(0, 19);
  review.stats[kind] += 1;
  review.idx += 1;
  if (review.idx >= review.total) {
    finishReview();
  } else {
    renderReviewCard();
  }
}

function finishReview() {
  review.done = true;
  $("#review-card").hidden = true;
  $("#review-grade").hidden = true;
  $("#review-progress").textContent = `完成`;
  $("#review-bar-fill").style.width = "100%";
  const s = review.stats;
  const remaining = computeDueCount();
  $("#review-summary-stats").innerHTML = `
    <span class="rs-item rs-know">认识 ${s.know}</span>
    <span class="rs-item rs-fuzzy">模糊 ${s.fuzzy}</span>
    <span class="rs-item rs-forget">忘记 ${s.forget}</span>
    <span class="rs-note">${remaining > 0 ? `今日还有 ${remaining} 个到期词` : "今日到期词已清零 ✓"}</span>`;
  $("#review-summary").hidden = false;
}

function closeReview() {
  review.open = false;
  $("#review-overlay").hidden = true;
  renderFamChips(); // 熟悉度已变，chips 计数同步（内部会刷新到期徽标）
  renderWordbookGrid(); // 本地缓存已同步更新熟悉度，无需重新拉取
  refreshStudyStats();
}

$("#review-btn").addEventListener("click", startReview);
$("#review-again").addEventListener("click", startReview);
$("#review-exit").addEventListener("click", closeReview);
$("#review-close").addEventListener("click", closeReview);
$("#review-card").addEventListener("click", revealReviewCard);
$("#review-speak").addEventListener("click", (e) => {
  e.stopPropagation();
  speak(review.queue[review.idx]?.word || "");
});
// 例句填空的提示：优先给中文释义，没有释义给首字母 + 词长（不触发翻面）
// 提示按钮：填空模式优先给中文释义（没有则首字母）；看义忆词模式释义已可见，给首字母
$("#review-cloze-hint").addEventListener("click", (e) => {
  e.stopPropagation();
  const w = review.queue[review.idx];
  if (!w) return;
  $("#review-hint").textContent =
    review.mode === "reverse" || !w.translation
      ? `提示：首字母 ${w.word.slice(0, 1).toUpperCase()}…，共 ${w.word.length} 个字母`
      : `提示：${w.translation}`;
  e.currentTarget.hidden = true;
});
document.querySelectorAll("#review-grade .grade-btn").forEach((btn) => {
  btn.addEventListener("click", () => gradeReviewCard(btn.dataset.grade));
});

// 复习浮层键盘：空格/回车显示答案，1/2/3 评分，R 朗读，Esc 结束
document.addEventListener("keydown", (e) => {
  if (!review.open || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) return;
  if (review.done) {
    if (e.key === "Escape") closeReview();
    else if (e.key === "Enter") startReview();
    return;
  }
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    if (!review.revealed) revealReviewCard();
    return;
  }
  if (e.key === "1") gradeReviewCard("forget");
  else if (e.key === "2") gradeReviewCard("fuzzy");
  else if (e.key === "3") gradeReviewCard("know");
  else if (e.key.toLowerCase() === "r") {
    // 看义忆词翻面前朗读会把答案念出来，禁止剧透
    if (!(review.mode === "reverse" && !review.revealed)) speak(review.queue[review.idx]?.word || "");
  } else if (e.key === "Escape") closeReview();
});

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("#export-csv").addEventListener("click", () => {
  if (!wordbookCache.length) return toast("生词本是空的");
  const rows = [
    ["word", "phonetic", "translation", "definition", "example", "source", "exam", "familiarity", "next_review", "added_at"],
  ];
  for (const w of wordbookCache) {
    rows.push([
      w.word,
      w.phonetic,
      w.translation,
      w.definition,
      w.sentence_text || "",
      w.source_file || "",
      w.exam_type || "",
      Math.max(0, Math.min(5, Number(w.familiarity) || 0)),
      String(w.next_review_at || "").slice(0, 10),
      w.added_at,
    ]);
  }
  const csvCell = (c) => {
    let s = String(c ?? "");
    // Excel 公式注入防护：= + - @ 开头的单元格会被当公式执行（如 LLM 返回的 =HYPERLINK(...)），前置单引号降级为文本
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = rows
    .map((r) => r.map(csvCell).join(","))
    .join("\r\n");
  downloadFile("\uFEFF" + csv, "wordbook.csv", "text/csv;charset=utf-8");
  toast("已导出 CSV", "ok");
});

$("#export-anki").addEventListener("click", () => {
  if (!wordbookCache.length) return toast("生词本是空的");
  const lines = wordbookCache.map((w) => {
    const back = [
      w.phonetic ? `<div>${escapeHtml(w.phonetic)}</div>` : "",
      w.translation ? `<div><br>${escapeHtml(w.translation)}</div>` : "",
      w.definition ? `<div><br>${escapeHtml(w.definition)}</div>` : "",
      w.sentence_text
        ? `<div><br><i>${escapeHtml(w.sentence_text)}</i><br>${escapeHtml(
            (w.exam_type ? `[${w.exam_type}] ` : "") + (w.source_file || "")
          )}</div>`
        : "",
    ].join("");
    // word 可经备份恢复写入任意字符：去制表/换行防止 TSV 错位，HTML 转义防 Anki「允许 HTML」渲染注入
    const front = escapeHtml(String(w.word).replace(/[\t\r\n]+/g, " "));
    return `${front}\t${back}`;
  });
  downloadFile(lines.join("\n"), "wordbook-anki.txt", "text/plain;charset=utf-8");
  toast("已导出 Anki（制表符分隔，导入时勾选“允许 HTML”）", "ok");
});

// ---------------------------------------------------------------------------
// 学习统计（生词本页顶部卡片）：连续打卡 / 今日待复习 / 今日已复习 / 累计 + 15 周热力图
// review_log 按客户端本地日期聚合；连续打卡：今天没复习不打断，从昨天往回数
// ---------------------------------------------------------------------------

const HEAT_WEEKS = 15; // 热力图覆盖周数
let statsCache = null;

// 热力图窗口起点：往前推 HEAT_WEEKS*7 天再回退到周一（保证列 = 完整一周，行 = 周一..周日）
function heatStartDate() {
  const d = new Date();
  d.setDate(d.getDate() - (HEAT_WEEKS * 7 - 1));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

async function refreshStudyStats() {
  try {
    statsCache = await api(`/api/stats?since=${localDateStr(heatStartDate())}`);
  } catch {
    return;
  }
  renderStudyStats();
}

function computeStreak(dailyMap) {
  const has = (d) => (dailyMap.get(d) || 0) > 0;
  let cursor = new Date();
  if (!has(localDateStr(cursor))) {
    cursor = new Date(Date.now() - 86400000); // 今天还没复习不打断连续记录
    if (!has(localDateStr(cursor))) return 0;
  }
  let n = 0;
  while (has(localDateStr(cursor))) {
    n += 1;
    cursor = new Date(cursor.getTime() - 86400000);
  }
  return n;
}

function renderStudyStats() {
  const el = $("#study-stats");
  if (!statsCache) {
    el.hidden = true;
    return;
  }
  const dailyMap = new Map((statsCache.daily || []).map((r) => [String(r.date), Number(r.n) || 0]));
  const today = localDateStr();
  $("#ss-streak").textContent = computeStreak(dailyMap);
  $("#ss-due").textContent = computeDueCount();
  $("#ss-today").textContent = dailyMap.get(today) || 0;
  $("#ss-total").textContent = statsCache.total_reviews || 0;

  // GitHub 风格热力图：列 = 一周，行 = 周一..周日；颜色按当日复习量分 5 档
  const chart = $("#ss-chart");
  const start = heatStartDate();
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const cells = [];
  const cursor = new Date(start);
  while (cursor <= today0) {
    const ds = localDateStr(cursor);
    const n = dailyMap.get(ds) || 0;
    const lvl = n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 9 ? 3 : 4;
    cells.push(`<i class="ss-cell l${lvl}" title="${ds} · 复习 ${n} 次"></i>`);
    cursor.setDate(cursor.getDate() + 1);
  }
  chart.innerHTML = cells.join("");
  el.hidden = !(statsCache.total_reviews > 0 || wordbookCache.length > 0);
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

async function loadSettings() {
  state.settings = await api("/api/settings").catch(() => null);
  refreshOcrHint();
}

async function loadSettingsForm() {
  const s = state.settings || (await loadSettings(), state.settings);
  if (!s) return;
  $("#llm-base-url").value = s.llm_base_url || "";
  $("#llm-base-url").placeholder = "https://api.openai.com/v1";
  $("#llm-model").value = s.llm_model || "";
  $("#llm-api-key").value = "";
  $("#llm-api-key").placeholder = s.llm_key_set ? `已配置（${s.llm_key_masked}），留空保持不变` : "sk-…";
  $("#mineru-token").value = "";
  $("#mineru-token").placeholder = s.mineru_token_set ? `已配置（${s.mineru_token_masked}），留空保持不变` : "粘贴 mineru.net 的 API Token";
  $("#llm-status").textContent = s.llm_key_set ? `已配置：${s.llm_key_masked}` : "未配置";
  $("#llm-status").className = `field-status ${s.llm_key_set ? "ok" : ""}`;
  $("#mineru-status").textContent = s.mineru_token_set ? `已配置：${s.mineru_token_masked}` : "未配置";
  $("#mineru-status").className = `field-status ${s.mineru_token_set ? "ok" : ""}`;
  // 站长卡片：只有 is_admin 才显示
  $("#admin-card").hidden = !s.is_admin;
  $("#admin-users").textContent = s.is_admin ? `已注册 ${s.users_count ?? 0} 位用户` : "";
  $("#reg-code").value = "";
  $("#reg-code").placeholder = s.registration_code_set ? "已开启注册码；留空保持，输入 - 清除" : "留空则任何人可注册";
  $("#reg-status").textContent = s.registration_code_set ? "已开启注册码保护" : "开放注册";
  $("#reg-status").className = `field-status ${s.registration_code_set ? "ok" : ""}`;
  initPushCard(); // 复习提醒卡的开关状态随当前浏览器的订阅情况刷新
}

$("#save-settings").addEventListener("click", async () => {
  const body = {};
  const baseUrl = $("#llm-base-url").value.trim();
  const model = $("#llm-model").value.trim();
  const llmKey = $("#llm-api-key").value.trim();
  const mineruToken = $("#mineru-token").value.trim();
  const regCode = $("#reg-code").value.trim();
  if (baseUrl) body.llm_base_url = baseUrl;
  if (model) body.llm_model = model;
  if (llmKey) body.llm_api_key = llmKey;
  if (mineruToken) body.mineru_api_token = mineruToken;
  try {
    if (Object.keys(body).length) {
      await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    // 注册码是站点级设置，走站长接口；输入 - 表示清除
    if (state.settings?.is_admin && regCode) {
      await api("/api/admin/site-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registration_code: regCode === "-" ? "" : regCode }),
      });
    }
    await loadSettings();
    await loadSettingsForm();
    toast("设置已保存", "ok");
  } catch (err) {
    toast(err.message, "err");
  }
});

// ---------------------------------------------------------------------------
// 每日复习提醒（Web Push）：空推送唤醒 SW，SW 拉取到期数后弹通知。
// 订阅归属当前浏览器设备，换设备需重新开启；推送走服务器 cron（每天 9:00）
// ---------------------------------------------------------------------------

function urlB64ToUint8Array(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function setPushUi(on) {
  const btn = $("#push-toggle");
  const status = $("#push-status");
  if (!btn) return;
  btn.textContent = on ? "关闭提醒" : "开启提醒";
  status.textContent = on ? "✓ 已开启，每天 9:00 提醒" : "未开启";
  status.className = `field-status ${on ? "ok" : ""}`;
}

async function initPushCard() {
  const card = $("#push-card");
  if (!card) return;
  // PushManager 只存在于安全上下文（https / localhost）；不支持的环境整卡隐藏
  if (!("PushManager" in window) || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    setPushUi(Boolean(sub));
    card.hidden = false;
  } catch {
    card.hidden = true;
  }
}

$("#push-toggle").addEventListener("click", async () => {
  const btn = $("#push-toggle");
  btn.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      try {
        await api("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      } catch {}
      await sub.unsubscribe();
      setPushUi(false);
      toast("已关闭每日复习提醒", "ok");
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("浏览器通知权限未授予，无法开启提醒");
      const { publicKey } = await api("/api/push/vapid-public");
      if (!publicKey) throw new Error("站点未配置推送服务");
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(publicKey),
      });
      const j = sub.toJSON();
      await api("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
      });
      setPushUi(true);
      toast("已开启每日复习提醒", "ok");
    }
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.disabled = false;
  }
});

$("#llm-test").addEventListener("click", async () => {  const btn = $("#llm-test");
  btn.disabled = true;
  btn.textContent = "测试中…";
  try {
    const { definition } = await api("/api/llm/define", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word: "abandon" }),
    });
    $("#llm-status").textContent = `✓ 连接成功（${definition.source}）`;
    $("#llm-status").className = "field-status ok";
  } catch (err) {
    $("#llm-status").textContent = err.message;
    $("#llm-status").className = "field-status err";
  } finally {
    btn.disabled = false;
    btn.textContent = "测试连接";
  }
});

$("#export-backup").addEventListener("click", async () => {
  try {
    const resp = await fetch("/api/export"); // cookie 随同源请求自动携带
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    downloadFile(await resp.text(), `ielts-vocab-backup-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
    toast("备份已下载", "ok");
  } catch (err) {
    toast(err.message, "err");
  }
});

// ---------------------------------------------------------------------------
// 备份恢复：选备份 JSON → 重放文档/句子 → 恢复生词本与设置（合并式，不删现有数据）
// ---------------------------------------------------------------------------

const RESTORE_SETTING_KEYS = new Set(["llm_base_url", "llm_model", "llm_api_key", "mineru_api_token"]);

$("#restore-backup").addEventListener("click", () => $("#restore-input").click());

$("#restore-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) await restoreFromBackup(file);
});

async function restoreFromBackup(file) {
  const status = $("#restore-status");
  let dump;
  try {
    dump = JSON.parse(await file.text());
  } catch {
    return toast("备份文件不是有效的 JSON", "err");
  }
  // 行内字段先过类型门再进载荷：这里若用 String() 兜底，对象字段会先变成
  // "[object Object]" 字符串，后端 strField 门看到的已是字符串，垃圾照样入库
  // （与 r21 后端口径一致：坏行丢弃，不拦截整个恢复流程）
  const docs = Array.isArray(dump.documents)
    ? dump.documents.filter((d) => d && d.id != null && typeof d.filename === "string" && d.filename.trim())
    : [];
  const sents = Array.isArray(dump.sentences)
    ? dump.sentences.filter((s) => s && typeof s.text === "string" && s.text.trim())
    : [];
  const wbs = Array.isArray(dump.wordbook)
    ? dump.wordbook.filter((w) => w && typeof w.word === "string" && w.word.trim())
    : [];
  const setts = Array.isArray(dump.user_settings)
    ? dump.user_settings.filter((x) => x && RESTORE_SETTING_KEYS.has(x.key) && typeof x.value === "string" && x.value.trim())
    : [];
  if (!docs.length && !wbs.length) return toast("备份里没有文档或生词，无需恢复", "err");

  const ok = confirm(
    `将从备份恢复：${docs.length} 份文档、${sents.length} 句、${wbs.length} 个生词。` +
      `\n恢复为合并式：不删除现有数据；同名文档会作为新文档再导入一份。继续？`
  );
  if (!ok) return;

  status.textContent = "恢复中…";
  status.className = "field-status";
  try {
    // 1) 文档 + 句子：按备份原顺序重放，/sentences 返回的新 id 用来做新旧句子映射
    const byDoc = new Map();
    for (const s of sents) {
      const key = Number(s.document_id);
      if (!byDoc.has(key)) byDoc.set(key, []);
      byDoc.get(key).push(s);
    }
    const sentIdMap = new Map(); // 旧句子 id → 新句子 id
    const docList = [...docs].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    for (let di = 0; di < docList.length; di++) {
      const d = docList[di];
      status.textContent = `恢复文档 ${di + 1}/${docList.length}…`;
      const doc = await api("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: d.filename.trim().slice(0, 255),
          exam_type: typeof d.exam_type === "string" ? d.exam_type : "Other",
        }),
      });
      const list = (byDoc.get(Number(d.id)) || []).sort(
        (a, b) => (Number(a.position) || 0) - (Number(b.position) || 0)
      );
      for (let i = 0; i < list.length; i += UPLOAD_CHUNK) {
        const chunk = list.slice(i, i + UPLOAD_CHUNK);
        const res = await api(`/api/documents/${doc.id}/sentences`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sentences: chunk.map((s) => ({ text: s.text.trim(), tokens: sentenceTokens(s.text) })),
            }),
        });
        (res.ids || []).forEach((nid, j) => {
          if (nid && chunk[j]?.id != null) sentIdMap.set(Number(chunk[j].id), nid);
        });
      }
    }

    // 2) 生词本：例句引用换成新库 id（换不到就只存单词），保留原熟悉度与收藏时间
    const wbRows = wbs.map((w) => ({
      word: w.word.trim().toLowerCase().slice(0, 64),
      phonetic: typeof w.phonetic === "string" ? w.phonetic : "",
      translation: typeof w.translation === "string" ? w.translation : "",
      definition: typeof w.definition === "string" ? w.definition : "",
      familiarity: Number(w.familiarity) || 0,
      last_reviewed_at: typeof w.last_reviewed_at === "string" ? w.last_reviewed_at.slice(0, 32) : "",
      next_review_at: typeof w.next_review_at === "string" ? w.next_review_at.slice(0, 32) : "", // 保留 SRS 计划，恢复后不全部变成今日到期
      added_at: typeof w.added_at === "string" ? w.added_at.slice(0, 32) : "",
      sentence_id: w.sentence_id != null ? sentIdMap.get(Number(w.sentence_id)) || null : null,
    }));
    for (let i = 0; i < wbRows.length; i += 100) {
      status.textContent = `恢复生词 ${Math.min(i + 100, wbRows.length)}/${wbRows.length}…`;
      await api("/api/wordbook/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ words: wbRows.slice(i, i + 100) }),
      });
    }

    // 3) 用户设置（LLM / OCR Key 等）
    if (setts.length) {
      await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(setts.map((x) => [x.key, x.value.trim()]))),
      });
    }

    status.textContent = "✓ 恢复完成";
    status.className = "field-status ok";
    searchCache.clear();
    await loadDocuments();
    await refreshWordbookSilent();
    await loadSettings();
    refreshStudyStats();
    toast(`恢复完成：${docList.length} 份文档、${wbRows.length} 个生词`, "ok");
  } catch (err) {
    status.textContent = err.message;
    status.className = "field-status err";
    toast("恢复失败：" + err.message, "err");
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async function init() {
  renderChips();
  renderWelcome();

  // PWA：注册 Service Worker（离线壳 + 可安装；Electron/file 环境自动跳过）
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  // 先确认会话；未登录则整个应用停在登录视图，不做任何业务请求
  const me = await api("/api/auth/me").catch(() => ({ user: null }));
  if (!me.user) {
    enterAuthMode();
    return;
  }
  exitAuthMode(me.user);

  await loadSettings();
  loadDocuments().catch(() => {});
  refreshWordbookSilent(); // 预热生词本集合：查词页马上能显示「已在生词本」
  refreshStudyStats(); // 连续打卡 / 今日待复习等统计

  // 极简 hash 路由：#q=abandon 直达搜索结果；#import / #wordbook / #settings 直达对应页
  // decodeURIComponent 对畸形 hash（如 #q=%zz）会抛 URIError，吞掉否则整个启动流程中断
  let hash = "";
  try {
    hash = decodeURIComponent(location.hash.slice(1));
  } catch {}
  if (hash.startsWith("q=")) {
    const word = hash.slice(2);
    $("#search-input").value = word;
    doSearch(word, true);
  } else if (["import", "wordbook", "settings"].includes(hash)) {
    document.querySelector(`[data-tab="${hash}"]`)?.click();
  }
})();
