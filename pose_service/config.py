"""設定：config.json 的值，再用命令列參數覆蓋。機器人的 token 不寫在檔案裡，用環境變數 ROBOT_TOKEN。"""
import argparse
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DEFAULTS = {
    "host": "127.0.0.1",
    "port": 8800,
    "source": "auto",          # auto：有攝影機就用，沒有就示範模式；camera；demo；或影片檔路徑
    "camera_index": 0,
    "width": 640,
    "height": 480,
    "model": "models/yolo11n-pose.onnx",
    "conf": 0.5,               # 人的信心分數低於這個就不算
    "max_people": 3,
    "device": "auto",          # auto：有顯示卡就用；cpu：強制用 CPU
    "hands": True,             # 手部辨識（手指、手勢）。不需要時關掉，每秒可以多跑幾張
    "max_hands": 2,
    "show_video": True,        # false：隱私模式，網頁只看得到骨架和圖卡框，伺服器不送出影像
    "robot": {"mode": "mock", "gateway": "http://127.0.0.1:8080", "robot_id": "zenbo-01"},
}


def load(argv=None):
    p = argparse.ArgumentParser(prog="python -m pose_service", description="YOLO 姿勢辨識服務")
    p.add_argument("--config", default=str(ROOT / "config.json"))
    p.add_argument("--source", help="auto／camera／demo／影片檔路徑")
    p.add_argument("--camera", type=int, dest="camera_index", help="攝影機編號（筆電內建通常是 0）")
    p.add_argument("--port", type=int)
    p.add_argument("--robot", dest="robot_mode", choices=["mock", "platform"])
    p.add_argument("--hide-video", action="store_true", help="隱私模式：不送出影像，只送骨架和圖卡")
    args = p.parse_args(argv)

    cfg = json.loads(json.dumps(DEFAULTS))
    path = Path(args.config)
    if path.exists():
        with open(path, encoding="utf-8") as f:
            user = json.load(f)
        robot = user.pop("robot", {})
        cfg.update(user)
        cfg["robot"].update(robot)
    for key in ("source", "camera_index", "port"):
        if getattr(args, key) is not None:
            cfg[key] = getattr(args, key)
    if args.robot_mode:
        cfg["robot"]["mode"] = args.robot_mode
    if args.hide_video:
        cfg["show_video"] = False
    cfg["robot"]["token"] = os.environ.get("ROBOT_TOKEN", "")
    model = Path(cfg["model"])
    cfg["model"] = str(model if model.is_absolute() else ROOT / model)
    return cfg
