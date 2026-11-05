"""影像來源。每一種都有 read()：回傳一張 BGR 影像（numpy 陣列），讀不到回傳 None。"""
import sys
import time
from pathlib import Path

import cv2
import numpy as np

# 只顯示 OpenCV 的錯誤；打不開攝影機時我們自己用中文說明（OpenCV 4 和 5 的寫法不同）
try:
    cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_ERROR)
except AttributeError:
    getattr(cv2, "setLogLevel", lambda level: None)(2)


def read_image(path):
    """讀圖片。cv2.imread 在 Windows 讀不了有中文的路徑（例如 C:\\Users\\王小明\\桌面），所以先用 numpy 讀成位元組"""
    return cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)


class CameraSource:
    kind = "camera"

    def __init__(self, index=0, width=640, height=480):
        # Windows 用 DirectShow 開攝影機比較快
        backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
        self.cap = cv2.VideoCapture(index, backend)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        ok = self.cap.isOpened() and self.cap.read()[0]
        if not ok:
            self.cap.release()
            raise RuntimeError(f"打不開攝影機 {index}（沒有接、或被別的程式佔用，例如 Teams、相機 App）")
        self.label = f"攝影機 {index}"

    def read(self):
        ok, frame = self.cap.read()
        return frame if ok else None

    def close(self):
        self.cap.release()


class VideoSource:
    """影片檔：播完從頭再播，照影片的速度送出畫面。沒有攝影機時可以拿錄好的影片測試。"""
    kind = "video"

    def __init__(self, path):
        self.cap = cv2.VideoCapture(str(path))
        if not self.cap.isOpened():
            raise RuntimeError(f"打不開影片檔 {path}")
        self.delay = 1.0 / (self.cap.get(cv2.CAP_PROP_FPS) or 30)
        self.next_t = time.perf_counter()
        self.label = f"影片 {Path(path).name}"

    def read(self):
        ok, frame = self.cap.read()
        if not ok:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = self.cap.read()
            if not ok:
                return None
        self.next_t += self.delay
        time.sleep(max(0.0, self.next_t - time.perf_counter()))
        return frame

    def close(self):
        self.cap.release()


class DemoSource:
    """示範模式：沒有攝影機也能跑。畫面是空白背景，骨架由 detector.DemoPose 產生。"""
    kind = "demo"
    label = "示範模式（沒有攝影機）"

    def __init__(self, width=640, height=480, fps=30):
        self.delay = 1.0 / fps
        self.next_t = time.perf_counter()
        y = np.linspace(40, 70, height, dtype=np.uint8)[:, None, None]
        self.frame = np.broadcast_to(y, (height, width, 3)).copy()

    def read(self):
        self.next_t += self.delay
        time.sleep(max(0.0, self.next_t - time.perf_counter()))
        return self.frame.copy()

    def close(self):
        pass


def open_source(cfg):
    """依 cfg["source"] 開影像來源。auto：先試攝影機，打不開就改示範模式。回傳 (來源, 說明訊息)"""
    src = str(cfg["source"])
    w, h = cfg["width"], cfg["height"]
    if src == "demo":
        return DemoSource(w, h), None
    if src in ("auto", "camera"):
        try:
            return CameraSource(cfg["camera_index"], w, h), None
        except RuntimeError as e:
            if src == "camera":
                raise
            return DemoSource(w, h), f"{e}，改用示範模式"
    return VideoSource(src), None
