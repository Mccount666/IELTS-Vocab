from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QComboBox,
    QLabel, QListWidget, QListWidgetItem, QFileDialog, QFrame
)
from PySide6.QtCore import Qt, QThread, Signal
from database import get_connection, get_documents, delete_document


EXAM_TYPES = ["IELTS", "CET-4", "CET-6", "TOEFL", "GRE", "Other"]


STYLESHEET = """
QPushButton#importBtn {
    background: #7B61FF; color: white; border: none;
    padding: 10px 24px; border-radius: 10px;
    font-size: 14px; font-weight: 600;
}
QPushButton#importBtn:hover { background: #6B51EF; }
QPushButton#importBtn:disabled { background: #ccc; }
QPushButton#pickBtn {
    background: #ffffff; color: #1a1a2e; border: 1.5px solid #e0dee7;
    padding: 10px 20px; border-radius: 10px; font-size: 14px;
}
QPushButton#pickBtn:hover { border-color: #7B61FF; }
QPushButton#delBtn {
    background: #fff0f0; color: #cc4444; border: 1px solid #ffcccc;
    padding: 6px 16px; border-radius: 8px; font-size: 13px;
}
QPushButton#delBtn:hover { background: #ffe0e0; }
QComboBox {
    padding: 8px 16px; border: 1.5px solid #e0dee7;
    border-radius: 10px; font-size: 14px; background: #fff;
}
QListWidget {
    border: 1px solid #e8e6f0; border-radius: 10px;
    background: #fff; padding: 4px;
}
QListWidget::item {
    padding: 8px 12px; border-radius: 6px;
}
QListWidget::item:selected {
    background: #f0edff;
}
QLabel#statusLabel {
    font-size: 14px; color: #6b6b80; padding: 4px;
}
QLabel#sectionTitle {
    font-size: 15px; font-weight: 600; color: #1a1a2e; padding: 4px 0;
}
"""


class ImportThread(QThread):
    finished_signal = Signal(int, str)
    error_signal = Signal(str)

    def __init__(self, filepath, exam_type):
        super().__init__()
        self.filepath = filepath
        self.exam_type = exam_type

    def run(self):
        try:
            from document_importer import import_file
            conn = get_connection()
            count = import_file(conn, self.filepath, self.exam_type)
            conn.close()
            import os
            name = os.path.basename(self.filepath)
            self.finished_signal.emit(count, name)
        except Exception as e:
            self.error_signal.emit(str(e))


class ImportView(QWidget):
    def __init__(self):
        super().__init__()
        self._thread = None
        self._setup_ui()
        self._refresh_list()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(16)

        bar = QHBoxLayout()
        self.pick_btn = QPushButton("选择文件")
        self.pick_btn.setObjectName("pickBtn")
        self.pick_btn.clicked.connect(self._pick_file)
        bar.addWidget(self.pick_btn)

        self.file_label = QLabel("未选择文件")
        self.file_label.setStyleSheet("color:#999; font-size:14px;")
        bar.addWidget(self.file_label, 1)

        self.exam_combo = QComboBox()
        self.exam_combo.addItems(EXAM_TYPES)
        bar.addWidget(self.exam_combo)

        self.import_btn = QPushButton("导入")
        self.import_btn.setObjectName("importBtn")
        self.import_btn.clicked.connect(self._do_import)
        bar.addWidget(self.import_btn)

        layout.addLayout(bar)

        self.status = QLabel("")
        self.status.setObjectName("statusLabel")
        layout.addWidget(self.status)

        title = QLabel("已导入文档")
        title.setObjectName("sectionTitle")
        layout.addWidget(title)

        self.doc_list = QListWidget()
        self.doc_list.setContextMenuPolicy(Qt.CustomContextMenu)
        layout.addWidget(self.doc_list, 1)

        del_btn = QPushButton("删除选中")
        del_btn.setObjectName("delBtn")
        del_btn.clicked.connect(self._delete_selected)
        layout.addWidget(del_btn, 0, Qt.AlignRight)

    def _pick_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self,
            "选择真题文件",
            "",
            "Documents (*.pdf *.docx *.txt *.md);;All Files (*)",
        )
        if path:
            self._filepath = path
            import os
            self.file_label.setText(os.path.basename(path))
            self.file_label.setStyleSheet("color:#333; font-size:14px;")

    def _do_import(self):
        if not hasattr(self, "_filepath") or not self._filepath:
            self.status.setText("请先选择文件")
            return
        self.import_btn.setEnabled(False)
        self.status.setText("正在导入...")
        self._thread = ImportThread(self._filepath, self.exam_combo.currentText())
        self._thread.finished_signal.connect(self._on_finished)
        self._thread.error_signal.connect(self._on_error)
        self._thread.start()

    def _on_finished(self, count, name):
        self.import_btn.setEnabled(True)
        self.status.setText(f"导入完成：{name}（{count} 条句子）")
        self._refresh_list()

    def _on_error(self, msg):
        self.import_btn.setEnabled(True)
        self.status.setText(f"导入失败：{msg}")

    def _refresh_list(self):
        self.doc_list.clear()
        conn = get_connection()
        docs = get_documents(conn)
        conn.close()
        for doc in docs:
            item = QListWidgetItem(
                f"{doc['filename']}  [{doc['exam_type']}]  {doc['imported_at']}"
            )
            item.setData(Qt.UserRole, doc["id"])
            self.doc_list.addItem(item)

    def _delete_selected(self):
        item = self.doc_list.currentItem()
        if not item:
            return
        doc_id = item.data(Qt.UserRole)
        conn = get_connection()
        delete_document(conn, doc_id)
        conn.commit()
        conn.close()
        self._refresh_list()
        self.status.setText("已删除文档")
