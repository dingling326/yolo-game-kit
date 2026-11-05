"""訓練自己的 YOLO 物件模型，再轉成 ONNX 放進 models/，辨識服務就能用（不需要 PyTorch）。

只有訓練要用到 PyTorch，所以用另一個環境 .venv-train（不要裝進 .venv）：
  py -3.11 -m venv .venv-train
  .venv-train\\Scripts\\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126
  .venv-train\\Scripts\\python.exe -m pip install ultralytics onnx onnxslim
  （沒有 NVIDIA 顯示卡：第二行改成 pip install torch torchvision，會用 CPU 訓練，比較慢）

訓練：
  .venv-train\\Scripts\\python.exe tools\\train_objects.py datasets\\card-detection\\data.yaml --name cards

做完會產生 models/cards-yolo11n.onnx，再把 config.json 的 "objects_model" 改成這個檔名、重開伺服器。
模型的類別名稱要對到 cards.json 的 "en"（例如 egg → {"name": "雞蛋", "en": "egg", ...}）。
"""
import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    p = argparse.ArgumentParser()
    p.add_argument("data", help="資料集的 data.yaml（Roboflow 匯出 YOLOv8／YOLO11 格式）")
    p.add_argument("--name", default="objects", help="模型名稱，會變成 models/<name>-yolo11n.onnx")
    p.add_argument("--epochs", type=int, default=100)
    p.add_argument("--imgsz", type=int, default=512, help="訓練和辨識的圖片大小；Roboflow 匯出 512 就用 512")
    p.add_argument("--batch", type=int, default=16)
    p.add_argument("--device", default="0", help="0＝第一張顯示卡；cpu＝用 CPU")
    args = p.parse_args()

    from ultralytics import YOLO
    model = YOLO("yolo11n.pt")                      # 從官方預訓練的權重開始（遷移學習）
    model.train(data=args.data, epochs=args.epochs, imgsz=args.imgsz, batch=args.batch, device=args.device,
                patience=30,                        # 30 輪都沒有進步就提早結束
                workers=2,                          # Windows 開太多會很慢
                project=str(ROOT / "runs"), name=args.name, exist_ok=True)

    best = ROOT / "runs" / args.name / "weights" / "best.pt"
    metrics = YOLO(best).val(data=args.data, split="test", imgsz=args.imgsz, device=args.device,
                             project=str(ROOT / "runs"), name=f"{args.name}-test", exist_ok=True)
    print(f"\n測試集：mAP50={metrics.box.map50:.3f}  mAP50-95={metrics.box.map:.3f}")

    onnx = Path(YOLO(best).export(format="onnx", imgsz=args.imgsz, simplify=True))
    dest = ROOT / "models" / f"{args.name}-yolo11n.onnx"
    shutil.copy(onnx, dest)
    print(f"\n完成！模型：{dest.relative_to(ROOT)}")
    print(f'下一步：config.json 加上  "objects_model": "models/{dest.name}"  再重開伺服器')


if __name__ == "__main__":       # Windows 一定要有這行，不然訓練開多個 worker 會出錯
    main()
