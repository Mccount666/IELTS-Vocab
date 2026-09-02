import re
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLineEdit, QPushButton,
    QScrollArea, QLabel, QFrame, QTextBrowser
)
from PySide6.QtCore import Qt
from database import get_connection
from search_engine import search


STYLESHEET = """
QLineEdit {
    padding: 10px 16px;
    border: 1.5px solid #e0dee7;
    border-radius: 10px;
    font-size: 15px;
    background: #ffffff;
}
QLineEdit:focus {
    border-color: #7B61FF;
}
QPushButton#searchBtn {
    background: #7B61FF;
    color: white;
    border: none;
    padding: 10px 24px;
    border-radius: 10px;
    font-size: 15px;
    font-weight: 600;
}
QPushButton#searchBtn:hover {
    background: #6B51EF;
}
QScrollArea {
    border: none;
    background: transparent;
}
QLabel#sectionTitle {
    font-size: 15px;
    font-weight: 600;
    color: #1a1a2e;
    padding: 4px 0;
}
QLabel#sourceLabel {
    font-size: 12px;
    color: #6b6b80;
}
QLabel#examBadge {
    font-size: 11px;
    color: #7B61FF;
    background: #f0edff;
    padding: 2px 8px;
    border-radius: 8px;
}
QLabel#welcomeLabel {
    font-size: 16px;
    color: #6b6b80;
    padding: 40px;
}
QTextBrowser {
    border: none;
    background: #faf9fc;
    border-radius: 10px;
    padding: 12px;
    font-size: 14px;
}
QFrame#sentenceCard {
    background: #ffffff;
    border: 1px solid #e8e6f0;
    border-radius: 10px;
}
QFrame#defCard {
    background: #faf9fc;
    border: 1px solid #e8e6f0;
    border-radius: 10px;
}
"""


def _highlight(text, word):
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    pattern = re.compile(re.escape(word), re.IGNORECASE)
    return pattern.sub(
        lambda m: f'<b style="color:#7B61FF;background:#f0edff;padding:1px 3px;border-radius:3px">{m.group()}</b>',
        text,
    )


class SearchView(QWidget):
    def __init__(self):
        super().__init__()
        self._current_word = ""
        self._setup_ui()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(16)

        search_bar = QHBoxLayout()
        self.input = QLineEdit()
        self.input.setPlaceholderText("输入单词，按回车查询...")
        self.input.returnPressed.connect(self._on_search)
        search_bar.addWidget(self.input, 1)

        btn = QPushButton("查询")
        btn.setObjectName("searchBtn")
        btn.clicked.connect(self._on_search)
        search_bar.addWidget(btn)
        layout.addLayout(search_bar)

        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        container = QWidget()
        self.results_layout = QVBoxLayout(container)
        self.results_layout.setSpacing(12)
        self.results_layout.addStretch()
        self.scroll.setWidget(container)
        layout.addWidget(self.scroll, 1)

        self._show_welcome()

    def _show_welcome(self):
        welcome = QLabel("输入任意单词，查看你在真题中遇到过的例句")
        welcome.setObjectName("welcomeLabel")
        welcome.setAlignment(Qt.AlignCenter)
        self.results_layout.insertWidget(0, welcome)

    def _clear_results(self):
        while self.results_layout.count() > 1:
            item = self.results_layout.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()

    def _on_search(self):
        word = self.input.text().strip()
        if not word:
            return
        self._current_word = word
        self._clear_results()
        self.input.setText(word)

        conn = get_connection()
        result = search(word, conn)
        conn.close()
        self._display(result)

    def _display(self, result):
        definition = result.get("definition")
        sentences = result.get("sentences", [])

        if definition:
            self._add_definition_card(definition)

        if sentences:
            title = QLabel(f"真题例句（{len(sentences)} 条）")
            title.setObjectName("sectionTitle")
            self.results_layout.insertWidget(
                self.results_layout.count() - 1, title
            )
            for s in sentences:
                self._add_sentence_card(s)
        else:
            hint = QLabel("未在已导入的真题中找到该单词的例句")
            hint.setStyleSheet("color:#999; font-size:14px; padding:16px;")
            self.results_layout.insertWidget(
                self.results_layout.count() - 1, hint
            )

    def _add_definition_card(self, definition):
        card = QFrame()
        card.setObjectName("defCard")
        layout = QVBoxLayout(card)
        layout.setContentsMargins(16, 12, 16, 12)

        header = QLabel(definition["word"])
        header.setStyleSheet(
            "font-size:18px; font-weight:700; color:#1a1a2e;"
        )
        layout.addWidget(header)

        if definition.get("phonetic"):
            ph = QLabel(f"/{definition['phonetic']}/")
            ph.setStyleSheet("font-size:14px; color:#6b6b80;")
            layout.addWidget(ph)

        if definition.get("translation"):
            tr = QLabel(definition["translation"])
            tr.setStyleSheet("font-size:14px; color:#333; padding-top:4px;")
            tr.setWordWrap(True)
            layout.addWidget(tr)

        if definition.get("definition"):
            defs = definition["definition"].split("\n")[:5]
            for d in defs:
                dl = QLabel(d.strip())
                dl.setStyleSheet("font-size:13px; color:#555;")
                dl.setWordWrap(True)
                layout.addWidget(dl)

        src = QLabel(f"释义来源：{definition.get('source', '')}")
        src.setStyleSheet("font-size:11px; color:#aaa; padding-top:6px;")
        layout.addWidget(src)

        self.results_layout.insertWidget(
            self.results_layout.count() - 1, card
        )

    def _add_sentence_card(self, sentence):
        card = QFrame()
        card.setObjectName("sentenceCard")
        layout = QVBoxLayout(card)
        layout.setContentsMargins(16, 12, 16, 12)

        browser = QTextBrowser()
        browser.setOpenExternalLinks(False)
        browser.setHtml(
            f'<div style="font-size:14px; line-height:1.6;">'
            f'{_highlight(sentence["text"], self._current_word)}'
            f"</div>"
        )
        browser.setFixedHeight(
            browser.document().size().height() + 20
        )
        layout.addWidget(browser)

        meta = QHBoxLayout()
        source = QLabel(sentence["source"])
        source.setObjectName("sourceLabel")
        meta.addWidget(source)
        badge = QLabel(sentence["exam_type"])
        badge.setObjectName("examBadge")
        meta.addWidget(badge)
        meta.addStretch()
        layout.addLayout(meta)

        self.results_layout.insertWidget(
            self.results_layout.count() - 1, card
        )
