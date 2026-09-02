// 文本处理管线单测 —— 期望值全部来自桌面版 text_processor.py 的真实输出（见 test/README 注释），
// 保证 Web 版与桌面版对同一份真题切出的句子、索引的词完全一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitSentences,
  tokenizeWords,
  lemmatize,
  sentenceTokens,
  buildSentencesPayload,
} from "../public/js/pipeline.js";

test("splitSentences 与 Python 版输出一致（缩写合并、引号、%后切分）", () => {
  assert.deepEqual(
    splitSentences('The theory was wrong. However, Dr. Smith disagreed. He went to the U.S. A. Then he said: "Knowledge is power!"'),
    [
      "The theory was wrong. However, Dr.",
      "Smith disagreed. He went to the U.S.",
      "A.",
      'Then he said: "Knowledge is power!"',
    ]
  );

  assert.deepEqual(
    splitSentences("Prices rose by 5%. The e.g. case matters; etc. were ignored. A new day came."),
    [
      "Prices rose by 5%.",
      "The e.g. case matters; etc. were ignored.",
      "A new day came.",
    ]
  );

  assert.deepEqual(
    splitSentences("It ends here.   Multiple   spaces. And MR. Brown vs. Ms. Lee met."),
    [
      "It ends here.",
      "Multiple spaces. And MR. Brown vs. Ms.",
      "Lee met.",
    ]
  );

  assert.deepEqual(splitSentences(""), []);
  assert.deepEqual(splitSentences("   \n\t  "), []);
});

test("tokenizeWords 与 Python 版正则一致（撇号词、数字后缀、大小写）", () => {
  assert.deepEqual(tokenizeWords("Don't stop believing, it's the CORE! U.S.-based firms; a 2nd plan."), [
    "don't",
    "stop",
    "believing",
    "it's",
    "the",
    "core",
    "u",
    "s",
    "based",
    "firms",
    "a",
    "nd",
    "plan",
  ]);
  assert.deepEqual(tokenizeWords("The the cat A sat on mats"), ["the", "the", "cat", "a", "sat", "on", "mats"]);
});

test("lemmatize 与 Python 规则版一致（含刻意保留的怪癖）", () => {
  const expected = {
    running: "runn",
    studies: "study",
    cars: "car",
    boxes: "box",
    class: "class",
    lived: "lived",
    stopped: "stopp",
    happiness: "happiness",
    tries: "try",
    went: "went",
    abandon: "abandon",
    dogs: "dog",
    watches: "watch",
    taken: "taken",
    "nation's": "nation",
    "dog's": "dog",
  };
  for (const [word, lemma] of Object.entries(expected)) {
    assert.equal(lemmatize(word), lemma, `lemmatize(${word})`);
  }
});

test("sentenceTokens：去重且丢弃长度 1 的词", () => {
  assert.deepEqual(sentenceTokens("The the cat A sat on mats"), ["the", "cat", "sat", "on", "mats"]);
});

test("buildSentencesPayload：句子 + token 载荷形状正确", () => {
  const payload = buildSentencesPayload("Coral reefs support marine life. Fish thrive there, too!");
  assert.equal(payload.length, 2);
  assert.equal(payload[0].text, "Coral reefs support marine life.");
  assert.deepEqual(payload[0].tokens, ["coral", "reefs", "support", "marine", "life"]);
  assert.ok(!payload[1].tokens.includes("too".slice(0, 1))); // 无单字符 token
  assert.ok(payload[1].tokens.includes("thrive"));
});
