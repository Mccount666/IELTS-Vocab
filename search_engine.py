import database
from dictionary import lookup
from text_processor import lemmatize


def search(word, conn):
    word = word.strip().lower()
    if not word:
        return {"definition": None, "sentences": []}

    definition = lookup(word)
    sentences = _find_sentences(conn, word)

    if not sentences:
        lemma = lemmatize(word)
        if lemma != word:
            sentences = _find_sentences(conn, lemma)

    return {"definition": definition, "sentences": sentences}


def _find_sentences(conn, word):
    rows = conn.execute(
        """
        SELECT DISTINCT s.id, s.text, s.document_id,
               d.filename, d.exam_type
        FROM words w
        JOIN word_sentences ws ON ws.word_id = w.id
        JOIN sentences s ON s.id = ws.sentence_id
        JOIN documents d ON d.id = s.document_id
        WHERE w.word = ? OR w.lemma = ?
        ORDER BY d.exam_type, s.document_id, s.position
        """,
        (word, word),
    ).fetchall()
    return [
        {
            "text": row["text"],
            "source": row["filename"],
            "exam_type": row["exam_type"],
        }
        for row in rows
    ]
