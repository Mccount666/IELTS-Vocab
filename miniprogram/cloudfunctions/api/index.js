const cloud = require('wx-server-sdk');
// Node 16.13 运行时没有原生 fetch，统一走 node-fetch（v2，CJS）
const fetch = require('node-fetch');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = [
  'users',
  'documents',
  'sentences',
  'word_index',
  'wordbook',
  'review_log',
  'user_settings',
  'site_settings',
  'dictionary_cache',
];

const WORD_RE = /[a-zA-Z]+(?:'[a-z]+)?/g;
const SRS_INTERVALS = [1, 2, 4, 8, 16, 32];

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    if (!openid) return fail('无法获取微信用户身份', 401);

    const action = event.action || event.route || event.op;
    const data = event.data || {};
    await ensureCollections();
    await ensureUser(openid);

    const routes = {
      'me.initUser': () => initUser(openid),
      'documents.create': () => createDocument(openid, data),
      'documents.list': () => listDocuments(openid),
      'documents.delete': () => deleteDocument(openid, data),
      'documents.appendSentences': () => appendSentences(openid, data),
      'sentences.get': () => getSentence(openid, data),
      'search.query': () => search(openid, data),
      'search.suggest': () => suggest(openid, data),
      'search.context': () => context(openid, data),
      'wordbook.list': () => listWordbook(openid, data),
      'wordbook.add': () => addWordbook(openid, data),
      'wordbook.delete': () => deleteWordbook(openid, data),
      'wordbook.review': () => reviewWordbook(openid, data),
      'wordbook.batch': () => batchWordbook(openid, data),
      'stats.get': () => stats(openid, data),
      'settings.get': () => getSettings(openid),
      'settings.save': () => saveSettings(openid, data),
      'llm.define': () => llmDefine(openid, data),
      'llm.translate': () => llmTranslate(openid, data),
      'dictionary.lookup': () => dictionaryLookup(openid, data),
      'mineru.requestUploadUrls': () => mineruRequestUploadUrls(openid, data),
      'mineru.batchResult': () => mineruBatchResult(openid, data),
      'mineru.extractText': () => mineruExtractText(openid, data),
    };

    if (!routes[action]) return fail(`未知操作：${action}`, 404);
    const result = await routes[action]();
    return ok(result);
  } catch (err) {
    console.error(err);
    return fail(err.message || '服务器内部错误', err.statusCode || 500);
  }
};

function ok(data = {}) {
  return { ok: true, data };
}

function fail(error, statusCode = 400) {
  return { ok: false, error, statusCode };
}

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDaysAtNoon(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(12, 0, 0, 0);
  return `${localDateString(date)} 12:00:00`;
}

function lemmatize(word) {
  word = String(word || '').toLowerCase();
  if (word.endsWith("'s")) word = word.slice(0, -2);
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.length > 5 ? word.slice(0, -2) : word;
  return word;
}

function tokenizeWords(text) {
  return (String(text || '').match(WORD_RE) || []).map((w) => w.toLowerCase());
}

function requireText(value, field) {
  const text = String(value || '').trim();
  if (!text) throw Object.assign(new Error(`缺少 ${field}`), { statusCode: 400 });
  return text;
}

function normalizeFamiliarity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(5, Math.round(n)));
}

function gradeReview(currentFamiliarity, grade) {
  const current = normalizeFamiliarity(currentFamiliarity);
  let next = current;
  let gradedAs = grade;
  if (grade === 'forgot') next = Math.max(0, current - 1);
  else if (grade === 'hard') next = current;
  else if (grade === 'know') next = Math.min(5, current + 1);
  else gradedAs = 'hard';
  const interval = gradedAs === 'know' ? SRS_INTERVALS[next] || 32 : 1;
  return {
    familiarity: next,
    gradedAs,
    reviewDate: localDateString(),
    reviewedAt: nowIso(),
    nextReviewAt: addDaysAtNoon(interval),
  };
}

async function getSiteSetting(key) {
  const row = await db.collection('site_settings').where({ key }).limit(1).get();
  return row.data.length ? row.data[0].value : '';
}

async function setSiteSetting(key, value) {
  const existing = await db.collection('site_settings').where({ key }).limit(1).get();
  if (existing.data.length) {
    await db.collection('site_settings').doc(existing.data[0]._id).update({ data: { value } });
  } else {
    await db.collection('site_settings').add({ data: { key, value } });
  }
}


// 安全读取当前用户自己的文档：doc(id).get() 不回 _openid，改用 where 查询校验归属
async function getOwnedDoc(collection, openid, id) {
  const rows = await db.collection(collection).where({ _id: id, _openid: openid }).limit(1).get();
  return rows.data.length ? rows.data[0] : null;
}

// 自举：云函数对所在环境有管理员权限，缺失的集合在首次调用时自动创建，
// 免去在控制台手动建集合的步骤。进程内缓存避免每次调用都探测。
let collectionsReady = false;

async function ensureCollections() {
  if (collectionsReady) return;
  for (const name of COLLECTIONS) {
    let exists = true;
    try {
      await db.collection(name).count();
    } catch (err) {
      exists = false;
    }
    if (!exists) {
      try {
        await db.createCollection(name);
        console.log(`created collection: ${name}`);
      } catch (err) {
        // 并发调用时集合可能已被其他实例创建，忽略“已存在”类错误
        console.warn(`createCollection ${name}:`, err.message || err);
      }
    }
  }
  collectionsReady = true;
}

async function ensureUser(openid) {
  const found = await db.collection('users').where({ _openid: openid }).limit(1).get();
  let adminOpenid = await getSiteSetting('adminOpenid');
  // 管理员固定制：第一个进入的用户身份永久钉进 site_settings.adminOpenid，
  // 之后管理员只认这个微信号（users 集合被清空也不会转移），其余人全是普通用户
  if (!adminOpenid && (await db.collection('users').count()).total === 0) {
    adminOpenid = openid;
    await setSiteSetting('adminOpenid', openid);
  }
  const isAdmin = adminOpenid === openid;
  if (found.data.length) {
    if (Boolean(found.data[0].isAdmin) !== isAdmin) {
      await db.collection('users').doc(found.data[0]._id).update({ data: { isAdmin } });
      found.data[0].isAdmin = isAdmin;
    }
    return found.data[0];
  }
  const doc = { _openid: openid, isAdmin, createdAt: nowIso() };
  const added = await db.collection('users').add({ data: doc });
  return { _id: added._id, ...doc };
}

async function initUser(openid) {
  const user = await ensureUser(openid);
  return { user: { openid, isAdmin: Boolean(user.isAdmin) }, collections: COLLECTIONS };
}

async function createDocument(openid, data) {
  const filename = requireText(data.filename, 'filename').slice(0, 255);
  const examType = String(data.examType || data.exam_type || 'Other').trim().slice(0, 32) || 'Other';
  const added = await db.collection('documents').add({
    data: { _openid: openid, filename, examType, importedAt: nowIso(), sentenceCount: 0 },
  });
  return { id: added._id, sentenceCount: 0 };
}

async function listDocuments(openid) {
  const res = await db.collection('documents').where({ _openid: openid }).orderBy('importedAt', 'desc').limit(100).get();
  return { documents: res.data };
}

async function deleteDocument(openid, data) {
  const documentId = requireText(data.documentId || data.id, 'documentId');
  const doc = await getOwnedDoc('documents', openid, documentId);
  if (!doc) throw Object.assign(new Error('文档不存在或不属于你'), { statusCode: 404 });
  await db.collection('documents').doc(documentId).remove();
  await removeWhere('sentences', { _openid: openid, documentId });
  await removeWhere('word_index', { _openid: openid, documentId });
  return { ok: true };
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function appendSentences(openid, data) {
  const documentId = requireText(data.documentId || data.id, 'documentId');
  const doc = await getOwnedDoc('documents', openid, documentId);
  if (!doc) throw Object.assign(new Error('文档不存在或不属于你'), { statusCode: 404 });
  const items = Array.isArray(data.sentences) ? data.sentences.slice(0, 500) : [];

  // 预处理：句子文档与索引 token 一次算好，避免上千次串行写库超时
  const prepared = [];
  let cursor = Number(doc.sentenceCount) || 0;
  for (const item of items) {
    const text = String(item.text || '').trim();
    if (!text) continue;
    const position = Number.isFinite(Number(item.position)) ? Number(item.position) : cursor;
    cursor = Math.max(cursor, position + 1);
    const tokens = Array.isArray(item.tokens) ? item.tokens : tokenizeWords(text);
    const unique = Array.from(new Set(tokens.map((w) => String(w || '').toLowerCase()).filter((w) => w.length >= 2)));
    prepared.push({ doc: { _openid: openid, documentId, text, position }, tokens: unique });
  }
  if (!prepared.length) return { inserted: 0, ids: [] };

  // 批量写句子（云数据库批量 add 不回传文档 id）
  for (const part of chunks(prepared.map((p) => p.doc), 100)) {
    await db.collection('sentences').add({ data: part });
  }

  // 回读本批句子的真实 _id：position 在同一文档内唯一且本批取值连续，
  // 按范围查回后用 position 对位，不依赖批量 add 的返回值形状
  const positions = prepared.map((p) => p.doc.position);
  const minPos = Math.min(...positions);
  const maxPos = Math.max(...positions);
  const back = await db.collection('sentences')
    .where({ _openid: openid, documentId, position: _.gte(minPos).and(_.lte(maxPos)) })
    .orderBy('position', 'asc')
    .limit(prepared.length)
    .get();
  const byPos = new Map(back.data.map((s) => [s.position, s._id]));
  const ids = prepared.map((p) => byPos.get(p.doc.position) || null);
  if (back.data.length < prepared.length) {
    console.warn(`appendSentences: 回读句子数 ${back.data.length} < 写入数 ${prepared.length}`);
  }

  // 批量写倒排索引
  const indexDocs = [];
  prepared.forEach((p, i) => {
    const sentenceId = ids[i];
    if (!sentenceId) return;
    for (const word of p.tokens) {
      indexDocs.push({ _openid: openid, word, lemma: lemmatize(word), sentenceId, documentId, examType: doc.examType || 'Other' });
    }
  });
  for (const part of chunks(indexDocs, 500)) {
    await db.collection('word_index').add({ data: part });
  }

  await db.collection('documents').doc(documentId).update({ data: { sentenceCount: _.inc(prepared.length) } });
  return { inserted: prepared.length, ids };
}

async function getSentence(openid, data) {
  const id = requireText(data.id, 'id');
  const row = await getOwnedDoc('sentences', openid, id);
  if (!row) throw Object.assign(new Error('句子不存在或不属于你'), { statusCode: 404 });
  return { sentence: row };
}

async function search(openid, data) {
  const query = requireText(data.word, 'word').toLowerCase().slice(0, 80);
  const lemma = lemmatize(query);
  const examType = String(data.examType || data.exam_type || '').trim();
  const values = Array.from(new Set([query, lemma]));
  const where = { _openid: openid, word: _.in(values) };
  if (examType && examType !== 'All') where.examType = examType;
  let index = await db.collection('word_index').where(where).limit(200).get();
  if (!index.data.length && lemma !== query) {
    const fallback = { _openid: openid, lemma };
    if (examType && examType !== 'All') fallback.examType = examType;
    index = await db.collection('word_index').where(fallback).limit(200).get();
  }
  const sentenceIds = Array.from(new Set(index.data.map((x) => x.sentenceId))).slice(0, 100);
  // 批量查句子（原 N+1 串行太慢），并带上来源文档名供前端引用
  const sentences = sentenceIds.length
    ? (await db.collection('sentences').where({ _openid: openid, _id: _.in(sentenceIds) }).limit(100).get()).data
    : [];
  const docIds = Array.from(new Set(sentences.map((s) => s.documentId))).filter(Boolean);
  const nameByDoc = new Map();
  for (const part of chunks(docIds, 90)) {
    const d = await db.collection('documents').where({ _openid: openid, _id: _.in(part) }).limit(90).get();
    for (const row of d.data) nameByDoc.set(row._id, row.filename);
  }
  for (const s of sentences) s.documentFilename = nameByDoc.get(s.documentId) || '';
  sentences.sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : a.position - b.position));
  const wb = await db.collection('wordbook').where({ _openid: openid, word: query }).limit(1).get();
  return { word: query, lemma, sentences, wordbookEntry: wb.data[0] || null };
}

async function suggest(openid, data) {
  const prefix = requireText(data.prefix, 'prefix').toLowerCase().slice(0, 40);
  const examType = String(data.examType || data.exam_type || '').trim();
  const where = { _openid: openid };
  if (examType && examType !== 'All') where.examType = examType;
  const rows = await db.collection('word_index').where(where).limit(500).get();
  const counts = new Map();
  for (const row of rows.data) {
    if (!row.word || (!row.word.startsWith(prefix) && !(row.lemma || '').startsWith(prefix))) continue;
    counts.set(row.word, (counts.get(row.word) || 0) + 1);
  }
  const suggestions = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([word, count]) => ({ word, count }));
  return { suggestions };
}

async function context(openid, data) {
  const documentId = requireText(data.documentId, 'documentId');
  const position = Number(data.position) || 0;
  const span = Math.max(1, Math.min(3, Number(data.span) || 2));
  const rows = await db.collection('sentences')
    .where({ _openid: openid, documentId, position: _.gte(position - span).and(_.lte(position + span)) })
    .orderBy('position', 'asc')
    .limit(span * 2 + 1)
    .get();
  return { sentences: rows.data };
}

async function listWordbook(openid) {
  const rows = await db.collection('wordbook').where({ _openid: openid }).orderBy('addedAt', 'desc').limit(500).get();
  const today = localDateString();
  return {
    words: rows.data,
    dueCount: rows.data.filter((x) => !x.nextReviewAt || String(x.nextReviewAt).slice(0, 10) <= today).length,
  };
}

async function addWordbook(openid, data) {
  const word = requireText(data.word, 'word').toLowerCase().slice(0, 80);
  const existing = await db.collection('wordbook').where({ _openid: openid, word }).limit(1).get();
  const payload = {
    phonetic: String(data.phonetic || ''),
    translation: String(data.translation || ''),
    definition: String(data.definition || ''),
    sentenceId: data.sentenceId || '',
  };
  if (existing.data.length) {
    await db.collection('wordbook').doc(existing.data[0]._id).update({ data: payload });
    return { id: existing.data[0]._id, updated: true };
  }
  const added = await db.collection('wordbook').add({
    data: { _openid: openid, word, ...payload, addedAt: nowIso(), familiarity: 0, lastReviewedAt: '', nextReviewAt: '' },
  });
  return { id: added._id, updated: false };
}

async function deleteWordbook(openid, data) {
  const id = requireText(data.id, 'id');
  const row = await getOwnedDoc('wordbook', openid, id);
  if (!row) throw Object.assign(new Error('生词不存在或不属于你'), { statusCode: 404 });
  await db.collection('wordbook').doc(id).remove();
  return { ok: true };
}

async function reviewWordbook(openid, data) {
  const id = requireText(data.id, 'id');
  const row = await getOwnedDoc('wordbook', openid, id);
  if (!row) throw Object.assign(new Error('生词不存在或不属于你'), { statusCode: 404 });
  const graded = gradeReview(row.familiarity, data.grade);
  await db.collection('wordbook').doc(id).update({
    data: { familiarity: graded.familiarity, lastReviewedAt: graded.reviewedAt, nextReviewAt: graded.nextReviewAt },
  });
  await db.collection('review_log').add({
    data: { _openid: openid, wordbookId: id, word: row.word, gradedAs: graded.gradedAs, familiarity: graded.familiarity, reviewDate: graded.reviewDate, reviewedAt: graded.reviewedAt },
  });
  return graded;
}

async function batchWordbook(openid, data) {
  const ids = Array.isArray(data.ids) ? data.ids.slice(0, 200).map(String) : [];
  if (!ids.length) return { changed: 0 };
  let changed = 0;
  for (const id of ids) {
    const row = await getOwnedDoc('wordbook', openid, id);
    if (!row) continue;
    if (data.type === 'delete') await db.collection('wordbook').doc(id).remove();
    if (data.type === 'familiarity') await db.collection('wordbook').doc(id).update({ data: { familiarity: normalizeFamiliarity(data.familiarity) } });
    changed += 1;
  }
  return { changed };
}

async function stats(openid, data) {
  const since = String(data.since || '').slice(0, 10) || localDateString();
  const logs = await db.collection('review_log').where({ _openid: openid, reviewDate: _.gte(since) }).limit(1000).get();
  const dailyMap = new Map();
  for (const log of logs.data) dailyMap.set(log.reviewDate, (dailyMap.get(log.reviewDate) || 0) + 1);
  const daily = Array.from(dailyMap.entries()).sort().map(([date, count]) => ({ date, count }));
  const wb = await db.collection('wordbook').where({ _openid: openid }).limit(500).get();
  const today = localDateString();
  return {
    daily,
    totalReviews: logs.data.length,
    wordCount: wb.data.length,
    dueCount: wb.data.filter((x) => !x.nextReviewAt || String(x.nextReviewAt).slice(0, 10) <= today).length,
    todayReviews: dailyMap.get(today) || 0,
  };
}

async function getSettings(openid) {
  const rows = await db.collection('user_settings').where({ _openid: openid }).limit(1).get();
  const s = rows.data[0] || {};
  return {
    llmBaseUrl: s.llmBaseUrl || '',
    llmModel: s.llmModel || '',
    llmProtocol: s.llmProtocol || 'openai',
    llmKeySet: Boolean(s.llmApiKey),
    mineruTokenSet: Boolean(s.mineruApiToken),
  };
}

async function saveSettings(openid, data) {
  const rows = await db.collection('user_settings').where({ _openid: openid }).limit(1).get();
  const payload = {
    llmBaseUrl: String(data.llmBaseUrl || '').trim(),
    llmModel: String(data.llmModel || '').trim(),
    updatedAt: nowIso(),
  };
  if (data.llmProtocol === 'openai' || data.llmProtocol === 'anthropic') payload.llmProtocol = data.llmProtocol;
  // Key/Token 只在非空时更新：前端表单「留空则不修改」，空字符串绝不能抹掉已存的 Key
  if (typeof data.llmApiKey === 'string' && data.llmApiKey.trim()) payload.llmApiKey = data.llmApiKey.trim();
  if (typeof data.mineruApiToken === 'string' && data.mineruApiToken.trim()) payload.mineruApiToken = data.mineruApiToken.trim();
  // 显式清除（UI 不会误发，仅主动清除动作使用）
  if (data.clearLlmKey === true) payload.llmApiKey = '';
  if (data.clearMineruToken === true) payload.mineruApiToken = '';
  if (rows.data.length) await db.collection('user_settings').doc(rows.data[0]._id).update({ data: payload });
  else await db.collection('user_settings').add({ data: { _openid: openid, ...payload } });
  return { ok: true };
}

// LLM / MinerU 集成层（临时片段文件，将被合并进 index.js 后删除）
// 双协议自适应：OpenAI Chat Completions + Anthropic Messages。
// Key 存 user_settings，只在云函数内使用，永不下发小程序端。

function llmProtocol(settings) {
  if (settings.llmProtocol === 'openai' || settings.llmProtocol === 'anthropic') return settings.llmProtocol;
  const base = String(settings.llmBaseUrl || '').toLowerCase();
  const model = String(settings.llmModel || '').toLowerCase();
  if (base.includes('anthropic') || model.startsWith('claude')) return 'anthropic';
  return 'openai';
}

function buildLlmRequest(settings, system, user) {
  const baseUrl = String(settings.llmBaseUrl || '').replace(/\/+$/, '');
  const model = settings.llmModel || (llmProtocol(settings) === 'anthropic' ? 'claude-3-5-haiku-latest' : 'gpt-4o-mini');
  const key = settings.llmApiKey || '';
  if (llmProtocol(settings) === 'anthropic') {
    return {
      url: `${baseUrl}/v1/messages`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      parse: (json) => {
        const block = (json.content || []).find((c) => c.type === 'text');
        return block ? block.text : '';
      },
    };
  }
  return {
    url: `${baseUrl}/chat/completions`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    parse: (json) => (json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : ''),
  };
}

async function llmChat(settings, system, user) {
  const req = buildLlmRequest(settings, system, user);
  const resp = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    throw Object.assign(new Error(`LLM 请求失败（${resp.status}）：${detail}`), { statusCode: 502 });
  }
  const json = await resp.json().catch(() => null);
  if (!json) throw Object.assign(new Error('LLM 返回不是合法 JSON'), { statusCode: 502 });
  const content = req.parse(json);
  if (!content) throw Object.assign(new Error('LLM 返回内容为空'), { statusCode: 502 });
  return content;
}

function parseJsonLoose(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) { /* 继续宽松提取 */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (e) { return null; }
}

async function llmDefine(openid, data) {
  const settings = await getSettingsRow(openid);
  if (!settings.llmApiKey) throw Object.assign(new Error('尚未配置 LLM API Key，请到「我的」页填写'), { statusCode: 400 });
  const word = requireText(data.word, 'word').toLowerCase().slice(0, 80);
  const cached = await db.collection('dictionary_cache').where({ word }).limit(1).get();
  if (cached.data.length) {
    const c = cached.data[0];
    return { word, phonetic: c.phonetic, translation: c.translation, definition: c.definition, examples: JSON.parse(c.examples || '[]'), source: c.source, cached: true };
  }
  const system = '你是一位严谨的英汉词典编辑。只输出一个 JSON 对象，不要输出任何其他文字。';
  const user =
    `请为英文单词 "${word}" 编写词典条目，输出 JSON，格式：\n` +
    `{"phonetic":"英式音标，形如 /əˈbændən/","translation":"中文释义：词性+含义，多个义项用「；」分隔","definition":"简明英文释义，一到两句","examples":[{"en":"英文例句","zh":"例句中文翻译"}]}\n` +
    `examples 恰好给 2 条，例句要贴近雅思/托福学术或生活语境。`;
  const content = await llmChat(settings, system, user);
  const parsed = parseJsonLoose(content);
  if (!parsed || !parsed.translation) throw Object.assign(new Error(`LLM 返回无法解析为词典条目：${String(content).slice(0, 200)}`), { statusCode: 502 });
  const entry = {
    word,
    phonetic: parsed.phonetic || '',
    translation: parsed.translation || '',
    definition: parsed.definition || '',
    examples: Array.isArray(parsed.examples) ? parsed.examples.slice(0, 4) : [],
    source: `LLM（${settings.llmModel || 'default'}）`,
  };
  await db.collection('dictionary_cache').add({ data: { ...entry, examples: JSON.stringify(entry.examples), updatedAt: nowIso() } });
  return { ...entry, cached: false };
}

async function llmTranslate(openid, data) {
  const settings = await getSettingsRow(openid);
  if (!settings.llmApiKey) throw Object.assign(new Error('尚未配置 LLM API Key，请到「我的」页填写'), { statusCode: 400 });
  const text = requireText(data.text, 'text').slice(0, 2000);
  const system = '你是专业翻译。把用户发来的英文翻译成自然流畅的简体中文，只输出译文本身，不要任何解释或引号。';
  const content = await llmChat(settings, system, text);
  return { translation: content.trim() };
}

// 免费词典兜底：dictionaryapi.dev（无需 Key），结果写进 dictionary_cache
async function dictionaryLookup(openid, data) {
  const word = requireText(data.word, 'word').toLowerCase().slice(0, 80);
  const cached = await db.collection('dictionary_cache').where({ word }).limit(1).get();
  if (cached.data.length) {
    const c = cached.data[0];
    return { word, phonetic: c.phonetic, translation: c.translation, definition: c.definition, examples: JSON.parse(c.examples || '[]'), source: c.source, cached: true };
  }
  const resp = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { timeout: 8000 }).catch(() => null);
  const arr = resp && resp.ok ? await resp.json().catch(() => null) : null;
  if (!Array.isArray(arr) || !arr.length) return { word, translation: '', definition: '', examples: [], source: '', cached: false, notFound: true };
  const e = arr[0];
  const phonetic = e.phonetic || (e.phonetics || []).map((p) => p.text).find(Boolean) || '';
  const meanings = e.meanings || [];
  const definition = (meanings[0] && meanings[0].definitions && meanings[0].definitions[0] && meanings[0].definitions[0].definition) || '';
  const partOfSpeech = (meanings[0] && meanings[0].partOfSpeech) || '';
  const examples = [];
  for (const m of meanings) {
    for (const d of m.definitions || []) {
      if (d.example && examples.length < 2) examples.push({ en: d.example, zh: '' });
    }
  }
  const entry = {
    word,
    phonetic,
    translation: partOfSpeech ? `${partOfSpeech} ${definition}`.slice(0, 200) : '',
    definition,
    examples,
    source: 'dictionaryapi.dev',
  };
  await db.collection('dictionary_cache').add({ data: { ...entry, examples: JSON.stringify(entry.examples), updatedAt: nowIso() } });
  return { ...entry, cached: false };
}

// MinerU OCR（扫描 PDF）：v4 batch 流程
const MINERU_BASE = 'https://mineru.net/api/v4';

async function mineruRequestUploadUrls(openid, data) {
  const settings = await getSettingsRow(openid);
  if (!settings.mineruApiToken) throw Object.assign(new Error('尚未配置 MinerU Token，请到「我的」页填写'), { statusCode: 400 });
  const files = Array.isArray(data.files) ? data.files.slice(0, 10) : [];
  if (!files.length) throw Object.assign(new Error('缺少 files'), { statusCode: 400 });
  const resp = await fetch(`${MINERU_BASE}/file-urls/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.mineruApiToken}` },
    body: JSON.stringify({ files: files.map((f) => ({ name: f.name, is_ocr: true, data_id: f.dataId || f.name })) }),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json) throw Object.assign(new Error(`MinerU 申请上传地址失败（${resp.status}）`), { statusCode: 502 });
  return { batchId: json.data.batch_id, fileUrls: (json.data.file_urls || []).slice(0, files.length) };
}

async function mineruBatchResult(openid, data) {
  const settings = await getSettingsRow(openid);
  if (!settings.mineruApiToken) throw Object.assign(new Error('尚未配置 MinerU Token，请到「我的」页填写'), { statusCode: 400 });
  const batchId = requireText(data.batchId, 'batchId');
  const resp = await fetch(`${MINERU_BASE}/extract-results/batch/${encodeURIComponent(batchId)}`, {
    headers: { Authorization: `Bearer ${settings.mineruApiToken}` },
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json) throw Object.assign(new Error(`MinerU 查询结果失败（${resp.status}）`), { statusCode: 502 });
  const items = (json.data && json.data.extract_result) || [];
  return {
    items: items.map((it) => ({ state: it.state, fileName: it.file_name || '', fullZipUrl: it.full_zip_url || '', errMsg: it.err_msg || '' })),
  };
}

// 结果 zip 域名白名单（与 Web 版一致），防 SSRF
const MINERU_ZIP_HOSTS = ['mineru.net', 'openxlab.org.cn', 'aliyuncs.com'];

async function mineruExtractText(openid, data) {
  const settings = await getSettingsRow(openid);
  if (!settings.mineruApiToken) throw Object.assign(new Error('尚未配置 MinerU Token，请到「我的」页填写'), { statusCode: 400 });
  const url = requireText(data.url, 'url');
  let parsed;
  try { parsed = new URL(url); } catch (e) { throw Object.assign(new Error('非法的结果下载地址'), { statusCode: 400 }); }
  if (!MINERU_ZIP_HOSTS.some((h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
    throw Object.assign(new Error('结果下载地址不在允许的域名内'), { statusCode: 400 });
  }
  const resp = await fetch(url);
  if (!resp.ok) throw Object.assign(new Error(`下载 MinerU 结果失败（${resp.status}）`), { statusCode: 502 });
  const buf = new Uint8Array(await resp.arrayBuffer());
  const { unzipSync, strFromU8 } = require('fflate');
  const files = unzipSync(buf);
  const mdName = Object.keys(files).find((n) => n.endsWith('.md') || n.endsWith('.markdown'));
  if (!mdName) throw Object.assign(new Error('结果压缩包中未找到 .md 全文文件'), { statusCode: 502 });
  return { text: strFromU8(files[mdName]) };
}

// settings 行的原始读取（含明文 Key，仅云函数内部使用）
async function getSettingsRow(openid) {
  const rows = await db.collection('user_settings').where({ _openid: openid }).limit(1).get();
  return rows.data[0] || {};
}

async function removeWhere(collection, where) {
  // 云函数端支持 where().remove() 批量删除，单次最多 100 条，循环清空
  let removed = 0;
  while (true) {
    const res = await db.collection(collection).where(where).remove().catch(() => null);
    if (!res || !res.stats) break;
    removed += res.stats.removed || 0;
    if (res.stats.removed < 100) break;
  }
  return removed;
}
