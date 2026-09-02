from PySide6.QtWidgets import QMainWindow, QTabWidget
from database import init_db
from ui.search_view import SearchView, STYLESHEET as SEARCH_SS
from ui.import_view import ImportView, STYLESHEET as IMPORT_SS


GLOBAL_SS = f"""
QMainWindow {{
    background: #f5f5f7;
}}
QTabWidget::pane {{
    border: none;
    background: #f5f5f7;
}}
QTabBar::tab {{
    padding: 10px 32px;
    font-size: 15px;
    border: none;
    border-bottom: 3px solid transparent;
    color: #6b6b80;
    margin: 0 4px;
}}
QTabBar::tab:selected {{
    color: #7B61FF;
    border-bottom: 3px solid #7B61FF;
}}
{SEARCH_SS}
{IMPORT_SS}
"""


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        init_db()
        self.setWindowTitle("雅思词汇助手 — 真题例句查询")
        self.resize(860, 640)
        self.setStyleSheet(GLOBAL_SS)

        tabs = QTabWidget()
        tabs.addTab(SearchView(), "查词")
        tabs.addTab(ImportView(), "导入")
        self.setCentralWidget(tabs)
