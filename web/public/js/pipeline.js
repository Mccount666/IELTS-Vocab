// 浏览器端文本处理管线 —— text_processor.py 的对齐移植 + 文件解析器。
// 分句/分词/去重在浏览器完成后，把 [{text, tokens}] 载荷发给 Worker 建索引，
// Worker 端只做 SQL（见 src/worker.js）。

// ---------------------------------------------------------------------------
// 分句：与 Python 版 split_sentences() 行为一致
// ---------------------------------------------------------------------------

const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"'“”])/;
const WORD_RE = /[a-zA-Z]+(?:'[a-z]+)?/g;

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs",
  "etc", "inc", "ltd", "co", "fig", "no", "vol", "pp",
  "e.g", "i.e", "u.s", "u.k",
]);

function endsWithAbbreviation(text) {
  const lastWord = text.replace(/[.!?]+$/, "").toLowerCase();
  for (const abbr of ABBREVIATIONS) {
    if (lastWord.endsWith(abbr)) return true;
  }
  return false;
}

export function splitSentences(text) {
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const rawParts = text.split(SENTENCE_END);
  const sentences = [];
  for (let part of rawParts) {
    part = part.trim();
    if (!part) continue;
    if (endsWithAbbreviation(part)) {
      if (sentences.length) sentences[sentences.length - 1] += " " + part;
      else sentences.push(part);
    } else {
      sentences.push(part);
    }
  }
  return sentences;
}

// ---------------------------------------------------------------------------
// 分词 / 词形还原 / 建索引载荷
// ---------------------------------------------------------------------------

export function tokenizeWords(text) {
  return (text.match(WORD_RE) || []).map((w) => w.toLowerCase());
}

export function lemmatize(word) {
  word = word.toLowerCase();
  if (word.endsWith("'s")) word = word.slice(0, -2);
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.length > 5 ? word.slice(0, -2) : word;
  return word;
}

// 单句的索引 token：唯一、长度 ≥ 2（与 Python build_index 一致）
export function sentenceTokens(text) {
  const seen = new Set();
  const out = [];
  for (const w of tokenizeWords(text)) {
    if (w.length < 2 || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

export function buildSentencesPayload(fullText) {
  return splitSentences(fullText).map((text) => ({ text, tokens: sentenceTokens(text) }));
}

// ---------------------------------------------------------------------------
// 文件解析：PDF（pdf.js）/ DOCX（mammoth）/ TXT / MD
// 这些 CDN 只在真正用到时才动态加载。
// ---------------------------------------------------------------------------

const PDFJS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs";

export async function extractPdfText(file, onProgress) {
  const pdfjs = await import(/* @vite-ignore */ PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  let text = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items) {
      text += item.str;
      text += item.hasEOL ? "\n" : " ";
    }
    text += "\n";
    if (onProgress) onProgress(p, doc.numPages);
  }
  return { text, pages: doc.numPages };
}

export async function extractDocxText(file) {
  if (!window.mammoth) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("mammoth 加载失败，请检查网络"));
      document.head.appendChild(s);
    });
  }
  const arrayBuffer = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer });
  return { text: result.value, pages: 0 };
}

export async function extractTextFile(file) {
  const text = await file.text();
  return { text, pages: 0 };
}

export async function extractAnyFile(file, onProgress) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return extractPdfText(file, onProgress);
  if (name.endsWith(".docx")) return extractDocxText(file);
  return extractTextFile(file);
}

// 判断 PDF 是否疑似扫描件：平均每页文本太少
export function looksLikeScanned(extractResult) {
  const pages = Math.max(extractResult.pages, 1);
  return extractResult.text.replace(/\s+/g, "").length < pages * 150;
}

// MinerU 结果 zip 中提取 .md 全文（fflate 解压）
export async function unzipMarkdown(arrayBuffer) {
  const { unzipSync, strFromU8 } = await import("https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js");
  const files = unzipSync(new Uint8Array(arrayBuffer));
  const mdName = Object.keys(files).find((n) => n.endsWith(".md") || n.endsWith(".markdown"));
  if (!mdName) throw new Error("MinerU 结果压缩包中未找到 .md 全文文件");
  return strFromU8(files[mdName]);
}
