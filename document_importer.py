from datetime import datetime
import database
from text_processor import split_sentences, build_index


def import_file(conn, filepath, exam_type):
    text = _extract_text(filepath)
    if not text.strip():
        return 0
    sentences = split_sentences(text)
    if not sentences:
        return 0
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    filename = _basename(filepath)
    doc_id = database.insert_document(conn, filename, exam_type, now)
    build_index(conn, doc_id, sentences)
    conn.commit()
    return len(sentences)


def _basename(filepath):
    import os
    return os.path.basename(filepath)


def _extract_text(filepath):
    lower = filepath.lower()
    if lower.endswith(".pdf"):
        return _extract_pdf(filepath)
    elif lower.endswith(".docx"):
        return _extract_docx(filepath)
    elif lower.endswith((".txt", ".md")):
        return _extract_txt(filepath)
    return ""


def _extract_pdf(filepath):
    import fitz
    doc = fitz.open(filepath)
    text = ""
    for page in doc:
        text += page.get_text()
    doc.close()
    return text


def _extract_docx(filepath):
    from docx import Document
    doc = Document(filepath)
    return "\n".join(p.text for p in doc.paragraphs)


def _extract_txt(filepath):
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        return f.read()
