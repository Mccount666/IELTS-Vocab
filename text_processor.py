import re

_SENTENCE_END = re.compile(
    r'(?<=[.!?])\s+(?=[A-Z0-9"\'\u201C\u201D])'
)
_WORD = re.compile(r"[a-zA-Z]+(?:'[a-z]+)?")

_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs",
    "etc", "inc", "ltd", "co", "fig", "no", "vol", "pp",
    "e.g", "i.e", "u.s", "u.k",
}


def split_sentences(text):
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    raw_parts = _SENTENCE_END.split(text)
    sentences = []
    for part in raw_parts:
        part = part.strip()
        if not part:
            continue
        if _ends_with_abbreviation(part):
            if sentences:
                sentences[-1] += " " + part
            else:
                sentences.append(part)
        else:
            sentences.append(part)
    return sentences


def _ends_with_abbreviation(text):
    last_word = text.rstrip(".!?").lower()
    for abbr in _ABBREVIATIONS:
        if last_word.endswith(abbr):
            return True
    return False


def tokenize_words(text):
    return [w.lower() for w in _WORD.findall(text)]


def lemmatize(word):
    word = word.lower()
    if word.endswith("'s"):
        word = word[:-2]
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 3 and word.endswith("es"):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    if len(word) > 5 and word.endswith("ing"):
        return word[:-3]
    if len(word) > 4 and word.endswith("ed"):
        return word[:-2] if len(word) > 5 else word
    return word


def build_index(conn, document_id, sentences):
    from database import get_or_create_word, link_word_sentence, insert_sentences

    insert_sentences(conn, document_id, sentences)
    for sentence_row in conn.execute(
        "SELECT id, text FROM sentences WHERE document_id = ? ORDER BY position",
        (document_id,),
    ):
        sentence_id = sentence_row["id"]
        words = tokenize_words(sentence_row["text"])
        seen = set()
        for w in words:
            if w in seen or len(w) < 2:
                continue
            seen.add(w)
            lemma = lemmatize(w)
            word_id = get_or_create_word(conn, w, lemma)
            link_word_sentence(conn, word_id, sentence_id)
