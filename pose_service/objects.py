"""自己訓練的 YOLO 物件辨識（ONNX 格式，用 onnxruntime 跑，不需要 PyTorch）。

用途：認出沒有黑白方塊的圖卡，或桌上的真實物品（牛奶、牙刷…）。
認到的東西用跟 ArUco 圖卡「一樣的格式」放進 msg.cards，所以圖卡問答這類遊戲不用改就能用。

模型的類別名稱（例如 "egg"）要對到 cards.json 某一張卡的 "en"，才知道它的中文名稱和圖示：
  {"id": 12, "name": "雞蛋", "en": "egg", "emoji": "🥚"}
模型裡有、cards.json 沒有的類別：不送出（避免遊戲收到不認識的卡）。

每個認到的東西：
  {"id": 12, "name": "雞蛋", "en": "egg", "emoji": "🥚",
   "corners": [[x, y] × 4], "center": [x, y], "size": 0.2,   # 跟 ArUco 圖卡一樣（corners 是框的四個角）
   "box": [左, 上, 右, 下], "score": 0.91, "source": "yolo"}
"""
import ast
import math

import cv2
import numpy as np


class YoloObjects:
    def __init__(self, model_path, cards, conf=0.5, iou=0.45, device="auto"):
        import onnxruntime as ort
        available = ort.get_available_providers()
        providers = [] if device == "cpu" else [
            p for p in ("CUDAExecutionProvider", "DmlExecutionProvider") if p in available]
        self.session = ort.InferenceSession(str(model_path), providers=providers + ["CPUExecutionProvider"])
        inp = self.session.get_inputs()[0]
        self.input_name = inp.name
        self.size = inp.shape[2] if isinstance(inp.shape[2], int) else 640
        self.conf, self.iou = conf, iou

        # 類別名稱存在 ONNX 的 metadata 裡（Ultralytics 匯出時寫的），例如 "{0: 'egg', 1: 'pillbox'}"
        meta = self.session.get_modelmeta().custom_metadata_map
        self.names = ast.literal_eval(meta["names"]) if "names" in meta else {}
        by_en = {c.get("en"): c for c in cards}
        self.class_card = {i: by_en[n] for i, n in self.names.items() if n in by_en}
        self.missing = [n for n in self.names.values() if n not in by_en]
        device_name = self.session.get_providers()[0].replace("ExecutionProvider", "")
        self.label = f"自訂物件（{len(self.class_card)} 類，{device_name}）"

    def detect(self, frame):
        h, w = frame.shape[:2]
        # 1. 等比例縮放到模型的大小，不足的地方補灰色（letterbox），跟訓練時一樣
        r = min(self.size / h, self.size / w)
        nw, nh = round(w * r), round(h * r)
        top, left = round((self.size - nh) / 2 - 0.1), round((self.size - nw) / 2 - 0.1)
        img = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)
        img = cv2.copyMakeBorder(img, top, self.size - nh - top, left, self.size - nw - left,
                                 cv2.BORDER_CONSTANT, value=(114, 114, 114))
        blob = np.ascontiguousarray(img[:, :, ::-1].transpose(2, 0, 1)[None], dtype=np.float32) / 255.0

        # 2. 推論。輸出是 (4＋類別數)×N：每個候選框有 4 個框座標，加上每一類的分數
        out = self.session.run(None, {self.input_name: blob})[0][0].T
        cls = out[:, 4:].argmax(axis=1)
        score = out[np.arange(len(out)), 4 + cls]
        ok = score > self.conf
        out, cls, score = out[ok], cls[ok], score[ok]
        if not len(out):
            return []

        # 3. NMS：同一個東西有很多重疊的框，每一類只留最好的
        cx, cy, bw, bh = out[:, 0], out[:, 1], out[:, 2], out[:, 3]
        boxes = np.stack([cx - bw / 2, cy - bh / 2, bw, bh], axis=1)
        keep = np.array(cv2.dnn.NMSBoxesBatched(boxes.tolist(), score.tolist(), cls.tolist(),
                                                self.conf, self.iou)).reshape(-1)

        # 4. 座標換回原本的畫面，再除以寬高變成 0～1
        found = []
        for i in keep:
            card = self.class_card.get(int(cls[i]))
            if card is None:
                continue
            x, y, bw_i, bh_i = boxes[i]
            x1, y1 = (x - left) / r / w, (y - top) / r / h
            x2, y2 = (x + bw_i - left) / r / w, (y + bh_i - top) / r / h
            x1, y1, x2, y2 = (min(max(float(v), 0.0), 1.0) for v in (x1, y1, x2, y2))
            rd = lambda v: round(v, 4)
            found.append({
                "id": card["id"], "name": card["name"], "en": card.get("en", ""), "emoji": card.get("emoji", ""),
                "corners": [[rd(x1), rd(y1)], [rd(x2), rd(y1)], [rd(x2), rd(y2)], [rd(x1), rd(y2)]],
                "center": [rd((x1 + x2) / 2), rd((y1 + y2) / 2)],
                "size": rd(math.sqrt(max(x2 - x1, 0) * max(y2 - y1, 0))),
                "box": [rd(x1), rd(y1), rd(x2), rd(y2)],
                "score": round(float(score[i]), 3), "source": "yolo",
            })
        return found


class CombinedCards:
    """同時用 ArUco 標記和自訂 YOLO 模型認卡，結果合在一起（最大、最靠近鏡頭的排第一）"""

    def __init__(self, *detectors):
        self.detectors = detectors
        self.label = "＋".join(d.label for d in detectors)

    def detect(self, frame):
        found = []
        for d in self.detectors:
            found.extend(d.detect(frame))
        best = {}
        for c in found:                    # 同一張卡被兩種方法都認到：留比較大的那個
            if c["id"] not in best or c["size"] > best[c["id"]]["size"]:
                best[c["id"]] = c
        return sorted(best.values(), key=lambda c: c["size"], reverse=True)
