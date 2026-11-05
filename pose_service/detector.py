"""姿勢辨識。每一種都有 detect(影像)：回傳畫面裡的人，格式見 README 的「資料格式」。

座標都換成 0～1（除以畫面寬高），遊戲不用管攝影機解析度。people[0] 是畫面裡最大（通常是最靠近）的人。
"""
import math
import time

import cv2
import numpy as np


class YoloPose:
    """YOLO11n-pose（ONNX 格式），用 onnxruntime 跑。不需要安裝 PyTorch。"""

    def __init__(self, model_path, conf=0.5, iou=0.45, max_people=3, device="auto"):
        """device：auto＝有顯示卡就用（要另外裝 onnxruntime-gpu 或 onnxruntime-directml）；cpu＝只用 CPU"""
        import onnxruntime as ort
        available = ort.get_available_providers()
        providers = [] if device == "cpu" else [
            p for p in ("CUDAExecutionProvider", "DmlExecutionProvider") if p in available]
        self.session = ort.InferenceSession(str(model_path), providers=providers + ["CPUExecutionProvider"])
        inp = self.session.get_inputs()[0]
        self.input_name = inp.name
        self.size = inp.shape[2] if isinstance(inp.shape[2], int) else 640
        self.conf, self.iou, self.max_people = conf, iou, max_people
        self.device = self.session.get_providers()[0].replace("ExecutionProvider", "")
        self.label = f"YOLO11n-pose（{self.device}）"

    def detect(self, frame):
        h, w = frame.shape[:2]
        # 1. 等比例縮放到 640×640，不足的地方補灰色（letterbox）
        r = min(self.size / h, self.size / w)
        nw, nh = round(w * r), round(h * r)
        top, left = round((self.size - nh) / 2 - 0.1), round((self.size - nw) / 2 - 0.1)
        img = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)
        img = cv2.copyMakeBorder(img, top, self.size - nh - top, left, self.size - nw - left,
                                 cv2.BORDER_CONSTANT, value=(114, 114, 114))
        blob = np.ascontiguousarray(img[:, :, ::-1].transpose(2, 0, 1)[None], dtype=np.float32) / 255.0

        # 2. 推論。輸出是 56×8400：8400 個候選框，每個有 4 個框座標＋1 個分數＋17 個關節×(x, y, 信心)
        out = self.session.run(None, {self.input_name: blob})[0][0].T
        out = out[out[:, 4] > self.conf]
        if not len(out):
            return []

        # 3. 同一個人會有很多重疊的框，用 NMS 只留最好的那個
        cx, cy, bw, bh = out[:, 0], out[:, 1], out[:, 2], out[:, 3]
        boxes = np.stack([cx - bw / 2, cy - bh / 2, bw, bh], axis=1)
        keep = np.array(cv2.dnn.NMSBoxes(boxes.tolist(), out[:, 4].tolist(), self.conf, self.iou)).reshape(-1)

        # 4. 座標換回原本的畫面，再除以寬高變成 0～1
        people = []
        for i in keep:
            x, y, bw_i, bh_i = boxes[i]
            box = [(x - left) / r / w, (y - top) / r / h, (x + bw_i - left) / r / w, (y + bh_i - top) / r / h]
            kp = out[i, 5:].reshape(17, 3)
            kx = (kp[:, 0] - left) / r / w
            ky = (kp[:, 1] - top) / r / h
            people.append({
                "score": round(float(out[i, 4]), 3),
                "box": [round(min(max(float(v), 0.0), 1.0), 4) for v in box],    # float()：numpy 的數字不能轉 JSON
                "kp": [[round(float(a), 4), round(float(b), 4), round(float(c), 3)] for a, b, c in zip(kx, ky, kp[:, 2])],
            })
        people.sort(key=lambda p: (p["box"][2] - p["box"][0]) * (p["box"][3] - p["box"][1]), reverse=True)
        for n, p in enumerate(people[:self.max_people]):
            p["id"] = n
        return people[:self.max_people]


class DemoPose:
    """示範模式的假骨架：輪流「不舉手 → 舉左手 → 舉右手 → 雙手舉高」，每個動作 3 秒，遊戲可以照樣玩。"""
    label = "示範骨架"
    device = "—"

    # 站著、手放下時的位置（0～1）。這個人面向鏡頭，所以他的左手在畫面右邊（x 比較大）
    BASE = {
        "nose": (0.50, 0.24), "left_eye": (0.52, 0.22), "right_eye": (0.48, 0.22),
        "left_ear": (0.54, 0.23), "right_ear": (0.46, 0.23),
        "left_shoulder": (0.59, 0.37), "right_shoulder": (0.41, 0.37),
        "left_elbow": (0.62, 0.50), "right_elbow": (0.38, 0.50),
        "left_wrist": (0.63, 0.62), "right_wrist": (0.37, 0.62),
        "left_hip": (0.56, 0.62), "right_hip": (0.44, 0.62),
        "left_knee": (0.565, 0.78), "right_knee": (0.435, 0.78),
        "left_ankle": (0.57, 0.93), "right_ankle": (0.43, 0.93),
    }
    RAISED = {"elbow": (0.63, 0.27), "wrist": (0.64, 0.13)}   # 手舉高時（左手；右手左右對稱）
    STEPS = [(), ("left",), ("right",), ("left", "right")]

    def __init__(self):
        from .keypoints import NAMES
        self.names = NAMES
        self.t0 = time.time()

    def detect(self, frame):
        t = time.time() - self.t0
        step, phase = divmod(t / 3.0, 1.0)
        raised = self.STEPS[int(step) % len(self.STEPS)]
        lift = min(1.0, math.sin(math.pi * phase) * 2.5)          # 每 3 秒：舉起 → 停住約 2.5 秒 → 放下
        sway = 0.01 * math.sin(t * 1.3)
        kp = []
        for name in self.names:
            x, y = self.BASE[name]
            side, _, part = name.partition("_")
            if side in raised and part in self.RAISED:
                rx, ry = self.RAISED[part]
                rx = rx if side == "left" else 1.0 - rx
                x, y = x + (rx - x) * lift, y + (ry - y) * lift
            kp.append([round(x + sway, 4), round(y, 4), 0.95])
        return [{"id": 0, "score": 0.99, "box": [0.33 + sway, 0.08, 0.67 + sway, 0.97], "kp": kp}]
