"""姿勢辨識服務：攝影機 → YOLO Pose → 關節座標，用 WebSocket 送給遊戲網頁。

對應 RobotPlatform 的架構：
  · 這個資料夾 ＝ 平台上的「辨識服務」（brain/pose），只看、只報告，不直接控制機器人
  · web/games/ ＝ 各團隊開發的遊戲（apps/games）
  · 機器人動作一律經過 /api/robot：預設是模擬機器人；接上平台時改由 Gateway 檢查後才送給機器人

檔案：
  config.py     讀 config.json 和命令列參數
  keypoints.py  17 個關節的名稱與骨架連線（COCO 格式）
  sources.py    影像來源：攝影機、影片檔、示範模式
  detector.py   YOLO Pose（ONNX）推論；示範模式的假骨架
  cards.py      圖卡辨識（ArUco 標記）；示範模式的假圖卡
  hands.py      手部辨識（MediaPipe，21 個點、手指、手勢）；示範模式的假手
  robot.py      機器人：模擬、或經過平台 Gateway
  server.py     網頁、影像串流、WebSocket、機器人 API
"""
