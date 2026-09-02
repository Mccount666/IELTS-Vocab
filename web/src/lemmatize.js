// 词形还原 —— 与桌面版 text_processor.lemmatize() 逐行为对齐的移植。
// 搜索时把 "running" 归一到 "run" 等，保证 Web 版与桌面版命中同一批句子。

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
