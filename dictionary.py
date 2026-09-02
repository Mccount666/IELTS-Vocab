import json
import sqlite3
import urllib.request
from config import ECDICT_PATH


def lookup(word):
    result = _lookup_ecdict(word)
    if result:
        return result
    return _lookup_online(word)


def _lookup_ecdict(word):
    if not ECDICT_PATH or not _file_exists(ECDICT_PATH):
        return None
    try:
        conn = sqlite3.connect(ECDICT_PATH)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT phonetic, translation, definition FROM stardict WHERE word = ?",
            (word.lower(),),
        ).fetchone()
        conn.close()
        if row:
            return {
                "word": word,
                "phonetic": row["phonetic"] or "",
                "translation": row["translation"] or "",
                "definition": row["definition"] or "",
                "source": "ECDICT",
            }
    except Exception:
        pass
    return None


def _lookup_online(word):
    url = f"https://api.dictionaryapi.dev/api/v2/entries/en/{word.lower()}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "IELTS-Vocab-App"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if isinstance(data, list) and data:
            entry = data[0]
            phonetic = ""
            meanings = []
            for m in entry.get("meanings", []):
                defs = [d.get("definition", "") for d in m.get("definitions", [])]
                meanings.append(f"[{m.get('partOfSpeech', '')}] {'; '.join(defs)}")
            return {
                "word": word,
                "phonetic": phonetic,
                "translation": "",
                "definition": "\n".join(meanings),
                "source": "Online API",
            }
    except Exception:
        pass
    return None


def _file_exists(path):
    import os
    return os.path.isfile(path)
