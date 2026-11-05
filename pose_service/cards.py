"""圖卡辨識：每張圖卡印一個 ArUco 標記（黑白方塊）。電腦認的是標記，圖案是給人看的。

為什麼不直接認圖案：要認「任何圖案」得先拍很多照片訓練模型；標記不用訓練、一般光線就很穩，CPU 一張畫面約 2 毫秒。
圖卡清單在 cards.json（id 是標記的號碼，0～49）。列印頁：/cards/print.html

每張認到的卡：
  {"id": 2, "name": "貓", "en": "cat", "emoji": "🐱",
   "corners": [[x, y] × 4],   # 標記的四個角（0～1），順序：左上、右上、右下、左下（以標記本身為準）
   "center": [x, y], "size": 0.12}   # size：標記大約佔畫面多寬，越大表示越靠近鏡頭
"""
import json
import math
import time

import cv2
import numpy as np

from .config import ROOT

DICTIONARY = cv2.aruco.DICT_4X4_50       # 4×4 的方塊比較大，遠一點也認得到；最多 50 張卡
CARDS_FILE = ROOT / "cards.json"


def load_cards(path=CARDS_FILE):
    with open(path, encoding="utf-8") as f:
        cards = json.load(f)["cards"]
    seen = set()
    for c in cards:
        if not (0 <= int(c["id"]) < 50) or c["id"] in seen:
            raise ValueError(f"cards.json 的 id 要是 0～49、而且不能重複：{c}")
        seen.add(c["id"])
    return cards


def marker_png(card_id, size=400):
    """產生一個標記的 PNG（四周留白邊，印出來才認得到）"""
    d = cv2.aruco.getPredefinedDictionary(DICTIONARY)
    img = cv2.aruco.generateImageMarker(d, int(card_id), size)
    pad = size // 6
    img = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255)
    ok, buf = cv2.imencode(".png", img)
    return buf.tobytes()


def _describe(card, pts):
    """pts：4 個角，已經是 0～1"""
    cx, cy = pts.mean(axis=0)
    x, y = pts[:, 0], pts[:, 1]
    area = 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))
    return {
        "id": card["id"], "name": card["name"], "en": card.get("en", ""), "emoji": card.get("emoji", ""),
        "corners": [[round(float(a), 4), round(float(b), 4)] for a, b in pts],
        "center": [round(float(cx), 4), round(float(cy), 4)],
        "size": round(math.sqrt(area), 4),
    }


class CardDetector:
    label = "圖卡（ArUco 標記）"

    def __init__(self, cards):
        self.cards = {c["id"]: c for c in cards}
        d = cv2.aruco.getPredefinedDictionary(DICTIONARY)
        self.detector = cv2.aruco.ArucoDetector(d, cv2.aruco.DetectorParameters())

    def detect(self, frame):
        h, w = frame.shape[:2]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        corners, ids, _ = self.detector.detectMarkers(gray)
        if ids is None:
            return []
        out = []
        for c, i in zip(corners, ids.ravel()):
            card = self.cards.get(int(i))
            if card is None:            # 不在 cards.json 裡的標記不理它
                continue
            out.append(_describe(card, c.reshape(4, 2) / [w, h]))
        out.sort(key=lambda c: c["size"], reverse=True)     # 最大（最靠近）的卡排第一
        return out


class DemoCards:
    """示範模式：照 cards.json 的順序，每 3 秒換一張卡（中間有 0.6 秒畫面沒有卡）"""
    label = "示範圖卡"

    def __init__(self, cards):
        self.cards = cards
        self.t0 = time.time()

    def detect(self, frame):
        t = time.time() - self.t0
        step, phase = divmod(t / 3.0, 1.0)
        if phase > 0.8 or not self.cards:
            return []
        card = self.cards[int(step) % len(self.cards)]
        # 畫面是 4:3，用「高度」當單位算正方形，再換回 0～1
        cx, cy, half, angle = 0.5 + 0.03 * math.sin(t), 0.42, 0.13, 0.15 * math.sin(t * 0.7)
        pts = []
        for dx, dy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            rx = dx * math.cos(angle) - dy * math.sin(angle)
            ry = dx * math.sin(angle) + dy * math.cos(angle)
            pts.append([cx + rx * half * 0.75, cy + ry * half])
        return [_describe(card, np.array(pts))]
