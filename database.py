import sqlite3
from config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    exam_type TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sentences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    position INTEGER NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,
    lemma TEXT,
    UNIQUE(word)
);

CREATE TABLE IF NOT EXISTS word_sentences (
    word_id INTEGER NOT NULL,
    sentence_id INTEGER NOT NULL,
    PRIMARY KEY (word_id, sentence_id),
    FOREIGN KEY (word_id) REFERENCES words(id),
    FOREIGN KEY (sentence_id) REFERENCES sentences(id)
);

CREATE INDEX IF NOT EXISTS idx_word_sentences_word ON word_sentences(word_id);
CREATE INDEX IF NOT EXISTS idx_word_sentences_sentence ON word_sentences(sentence_id);
CREATE INDEX IF NOT EXISTS idx_words_lemma ON words(lemma);
CREATE INDEX IF NOT EXISTS idx_sentences_document ON sentences(document_id);
"""


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_connection()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


def insert_document(conn, filename, exam_type, imported_at):
    cur = conn.execute(
        "INSERT INTO documents (filename, exam_type, imported_at) VALUES (?, ?, ?)",
        (filename, exam_type, imported_at),
    )
    return cur.lastrowid


def insert_sentences(conn, document_id, sentences):
    for i, text in enumerate(sentences):
        conn.execute(
            "INSERT INTO sentences (document_id, text, position) VALUES (?, ?, ?)",
            (document_id, text, i),
        )


def get_or_create_word(conn, word, lemma=None):
    row = conn.execute("SELECT id FROM words WHERE word = ?", (word,)).fetchone()
    if row:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO words (word, lemma) VALUES (?, ?)", (word, lemma)
    )
    return cur.lastrowid


def link_word_sentence(conn, word_id, sentence_id):
    conn.execute(
        "INSERT OR IGNORE INTO word_sentences (word_id, sentence_id) VALUES (?, ?)",
        (word_id, sentence_id),
    )


def get_documents(conn):
    return conn.execute(
        "SELECT * FROM documents ORDER BY imported_at DESC"
    ).fetchall()


def delete_document(conn, document_id):
    sentence_ids = [
        r["id"]
        for r in conn.execute(
            "SELECT id FROM sentences WHERE document_id = ?", (document_id,)
        ).fetchall()
    ]
    for sid in sentence_ids:
        conn.execute(
            "DELETE FROM word_sentences WHERE sentence_id = ?", (sid,)
        )
    conn.execute("DELETE FROM sentences WHERE document_id = ?", (document_id,))
    conn.execute("DELETE FROM documents WHERE id = ?", (document_id,))
