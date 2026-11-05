"""手部辨識：MediaPipe Hand Landmarker，每隻手 21 個點，再算出每根手指有沒有伸直、比的是什麼手勢。

YOLO Pose 只找得到手腕；要看手指就要用這個模組。CPU 一張畫面約 20 毫秒。
沒有安裝 mediapipe 時，這個模組會自動關掉（其他遊戲照常可以玩）。

每隻認到的手：
  {"side": "left",                 # 被拍的人「自己的」左手／右手（跟 YOLO Pose 的 left／right 一樣）
   "score": 0.96,
   "kp": [[x, y] × 21],            # 0～1。0 是手腕；每根手指 4 個點，從指根到指尖（見 README）
   "center": [x, y], "size": 0.2,  # size：手大約佔畫面多高，越大越靠近鏡頭
   "fingers": [true, true, true, false, false],   # 拇指、食指、中指、無名指、小指有沒有伸直
   "count": 3,                     # 伸直幾根
   "gesture": "scissors"}          # rock 石頭／paper 布／scissors 剪刀／thumbs_up 讚／point 比一，認不出來是 null
"""
import math
import os
import time

os.environ.setdefault("GLOG_minloglevel", "2")       # MediaPipe 的 C++ 記錄很多，只留錯誤

from .config import ROOT

MODEL = ROOT / "models" / "hand_landmarker.task"

# 21 個點的連線（畫手的骨架用）
CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),            # 拇指
    (0, 5), (5, 6), (6, 7), (7, 8),            # 食指
    (5, 9), (9, 10), (10, 11), (11, 12),       # 中指
    (9, 13), (13, 14), (14, 15), (15, 16),     # 無名指
    (13, 17), (0, 17), (17, 18), (18, 19), (19, 20),   # 小指、手掌
]
TIPS, PIPS = (8, 12, 16, 20), (6, 10, 14, 18)  # 食指～小指：指尖、第二個關節


class HandsUnavailable(Exception):
    pass


def classify(kp, aspect=4 / 3):
    """kp：21 個 [x, y]（0～1）。aspect：畫面寬／高（算距離要換成同樣的單位）。回傳 (fingers, count, gesture)"""
    pts = [(x * aspect, y) for x, y in kp]

    def d(a, b):
        return math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1])

    # 食指～小指：指尖離手腕比第二個關節遠，就是伸直（手怎麼轉都適用）
    fingers = [d(0, tip) > d(0, pip) * 1.1 for tip, pip in zip(TIPS, PIPS)]
    # 拇指：指尖離小指根部夠遠（往旁邊張開），或離食指根部夠遠（往上翹），就是伸直；握拳時拇指會靠到手掌上
    thumb = d(4, 17) > d(2, 17) * 1.1 or d(4, 5) > d(0, 5) * 0.6
    fingers = [thumb] + fingers
    count = sum(fingers)
    _, index, middle, ring, pinky = fingers

    gesture = None
    if index and middle and ring and pinky:
        gesture = "paper"
    elif index and middle and not ring and not pinky:
        gesture = "scissors"
    elif index and not middle and not ring and not pinky:
        gesture = "point"
    elif not (index or middle or ring or pinky):
        # 四指都彎：拇指往上翹是「讚」，不然是「石頭」
        up = thumb and pts[4][1] < min(pts[5][1], pts[0][1]) - 0.3 * d(0, 9)
        gesture = "thumbs_up" if up else "rock"
    return fingers, count, gesture


def describe(side, score, kp, aspect):
    fingers, count, gesture = classify(kp, aspect)
    xs, ys = [p[0] for p in kp], [p[1] for p in kp]
    return {
        "side": side, "score": round(float(score), 3),
        "kp": [[round(float(x), 4), round(float(y), 4)] for x, y in kp],
        "center": [round(sum(xs) / 21, 4), round(sum(ys) / 21, 4)],
        "size": round(max(ys) - min(ys), 4),
        "fingers": fingers, "count": count, "gesture": gesture,
    }


class HandDetector:
    label = "手部（MediaPipe）"

    def __init__(self, model_path=MODEL, max_hands=2):
        try:
            import mediapipe as mp
            from mediapipe.tasks.python import BaseOptions, vision
        except ImportError as e:
            raise HandsUnavailable("沒有安裝 mediapipe（重跑「1. 安裝環境」）") from e
        if not os.path.exists(model_path):
            raise HandsUnavailable(f"找不到手部模型 {model_path}")
        self.mp = mp
        # 模型先自己讀成位元組再交給 MediaPipe：MediaPipe 在 Windows 開不了有中文的路徑（例如 C:\Users\王小明\桌面）
        with open(model_path, "rb") as f:
            model = f.read()
        opts = vision.HandLandmarkerOptions(base_options=BaseOptions(model_asset_buffer=model),
                                            running_mode=vision.RunningMode.VIDEO, num_hands=max_hands)
        try:
            self.detector = vision.HandLandmarker.create_from_options(opts)
        except Exception as e:
            raise HandsUnavailable(f"手部模型載入失敗：{e}") from e
        self.last_ts = 0

    def detect(self, frame):
        import cv2
        h, w = frame.shape[:2]
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        ts = max(int(time.monotonic() * 1000), self.last_ts + 1)     # 影片模式的時間要一直變大
        self.last_ts = ts
        result = self.detector.detect_for_video(image, ts)
        out = []
        for lm, handed in zip(result.hand_landmarks, result.handedness):
            # 實測（tests/hands.jpg 跟 YOLO Pose 的 left_wrist／right_wrist 對照）：送原始畫面時，
            # MediaPipe 的 Left／Right 就已經是「被拍的人自己的」左右，不用對調
            side = handed[0].category_name.lower()
            out.append(describe(side, handed[0].score, [(p.x, p.y) for p in lm], w / h))
        out.sort(key=lambda hnd: hnd["size"], reverse=True)
        return out


# ---------------------------------------------------------------- 示範模式

# 一隻張開的手（手腕在原點、往上是負的），單位約是「手腕到中指根部」的長度
OPEN_HAND = [
    (0, 0),
    (-0.35, -0.25), (-0.6, -0.45), (-0.8, -0.65), (-0.95, -0.85),      # 拇指
    (-0.3, -0.95), (-0.35, -1.35), (-0.38, -1.6), (-0.4, -1.85),       # 食指
    (0, -1.0), (0, -1.45), (0, -1.72), (0, -1.98),                     # 中指
    (0.28, -0.95), (0.32, -1.35), (0.35, -1.58), (0.37, -1.8),         # 無名指
    (0.52, -0.82), (0.6, -1.12), (0.65, -1.32), (0.7, -1.5),           # 小指
]
DEMO_SHAPES = {"rock": [False] * 5, "scissors": [False, True, True, False, False], "paper": [True] * 5}


def demo_hand(fingers):
    """依照哪幾根手指伸直，把 OPEN_HAND 的手指彎起來"""
    pts = [list(p) for p in OPEN_HAND]
    if not fingers[0]:
        pts[3], pts[4] = [-0.4, -0.6], [-0.15, -0.75]                  # 拇指收到手掌上
    for n, up in enumerate(fingers[1:]):
        if up:
            continue
        mcp = 5 + 4 * n
        mx, my = OPEN_HAND[mcp]
        pts[mcp + 1] = [mx, my - 0.3]                                  # 第二個關節稍微抬起
        pts[mcp + 2] = [mx, my - 0.15]
        pts[mcp + 3] = [mx * 0.9, my * 0.6]                            # 指尖彎回手掌
    return pts


class DemoHands:
    """示範模式：一隻右手在畫面裡輪流比 石頭 → 剪刀 → 布，每個 2.5 秒"""
    label = "示範手部"
    ORDER = ("rock", "scissors", "paper")

    def __init__(self):
        self.t0 = time.time()

    def detect(self, frame):
        t = time.time() - self.t0
        step, phase = divmod(t / 2.5, 1.0)
        if phase > 0.85:
            return []                                                  # 換手勢中
        shape = DEMO_SHAPES[self.ORDER[int(step) % len(self.ORDER)]]
        cx, cy, s = 0.30 + 0.02 * math.sin(t), 0.62, 0.11
        kp = [(cx + x * s * 0.75, cy + y * s) for x, y in demo_hand(shape)]
        return [describe("right", 0.97, kp, 4 / 3)]
