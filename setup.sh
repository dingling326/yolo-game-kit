#!/bin/sh
# macOS／Linux 第一次使用：建立 .venv 並安裝套件
set -e
cd "$(dirname "$0")"
PY=$(command -v python3.12 || command -v python3.11 || command -v python3 || true)
if [ -z "$PY" ]; then echo "找不到 Python 3，請先安裝 Python 3.12"; exit 1; fi
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --disable-pip-version-check -q --upgrade pip
# 舊版用 opencv-python，現在改用 opencv-contrib-python；兩個同時存在會互相蓋掉
.venv/bin/python -m pip show -q opencv-python >/dev/null 2>&1 && .venv/bin/python -m pip uninstall -y -q opencv-python
.venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt
# 有 NVIDIA 顯示卡（Linux）：裝語音辨識用的顯示卡套件；macOS 沒有 NVIDIA，語音辨識用 CPU
if command -v nvidia-smi >/dev/null 2>&1; then
  .venv/bin/python -m pip install --disable-pip-version-check -q -r requirements-gpu.txt || echo "顯示卡套件安裝失敗，語音辨識改用 CPU"
fi
.venv/bin/python -c "import cv2, onnxruntime, aiohttp, mediapipe, faster_whisper, opencc; cv2.aruco; print('檢查通過')"
echo "完成！按 F5 啟動"
