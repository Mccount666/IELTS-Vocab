const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"'“”])/;
const WORD_RE = /[a-zA-Z]+(?:'[a-z]+)?/g;

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs',
  'etc', 'inc', 'ltd', 'co', 'fig', 'no', 'vol', 'pp',
  'e.g', 'i.e', 'u.s', 'u.k',
]);

function endsWithAbbreviation(text) {
  const lastWord = text.replace(/[.!?]+$/, '').toLowerCase();
  for (const abbr of ABBREVIATIONS) {
    if (lastWord.endsWith(abbr)) return true;
  }
  return false;
}

function splitSentences(text) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const rawParts = text.split(SENTENCE_END);
  const sentences = [];
  for (let part of rawParts) {
    part = part.trim();
    if (!part) continue;
    if (endsWithAbbreviation(part)) {
      if (sentences.length) sentences[sentences.length - 1] += ` ${part}`;
      else sentences.push(part);
    } else {
      sentences.push(part);
    }
  }
  return sentences;
}

function tokenizeWords(text) {
  return (String(text || '').match(WORD_RE) || []).map((w) => w.toLowerCase());
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

function sentenceTokens(text) {
  const seen = new Set();
  const out = [];
  for (const w of tokenizeWords(text)) {
    if (w.length < 2 || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function buildSentencesPayload(fullText) {
  return splitSentences(fullText).map((text) => ({ text, tokens: sentenceTokens(text) }));
}

module.exports = {
  splitSentences,
  tokenizeWords,
  lemmatize,
  sentenceTokens,
  buildSentencesPayload,
};
