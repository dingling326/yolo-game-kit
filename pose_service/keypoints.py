"""YOLO Pose 的 17 個關節（COCO 格式）。left／right 是「被拍的那個人」自己的左右，不是畫面的左右。"""

NAMES = [
    "nose",                                   # 0 鼻子
    "left_eye", "right_eye",                  # 1, 2 眼睛
    "left_ear", "right_ear",                  # 3, 4 耳朵
    "left_shoulder", "right_shoulder",        # 5, 6 肩膀
    "left_elbow", "right_elbow",              # 7, 8 手肘
    "left_wrist", "right_wrist",              # 9, 10 手腕
    "left_hip", "right_hip",                  # 11, 12 髖部
    "left_knee", "right_knee",                # 13, 14 膝蓋
    "left_ankle", "right_ankle",              # 15, 16 腳踝
]

# 畫骨架時要連起來的關節（編號對應 NAMES）
SKELETON = [
    (5, 7), (7, 9), (6, 8), (8, 10),          # 手臂
    (5, 6), (5, 11), (6, 12), (11, 12),       # 身體
    (11, 13), (13, 15), (12, 14), (14, 16),   # 腿
    (0, 1), (0, 2), (1, 3), (2, 4),           # 臉
]
