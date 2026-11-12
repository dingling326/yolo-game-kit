# YOLO 體感遊戲工作坊

攝影機拍到你 → 辨識服務找出你身上 17 個關節、你的手指、你拿的圖卡 → 你寫的網頁遊戲判斷動作 → 叫機器人說話、點頭。

```
攝影機 ──► 辨識服務（Python，已經寫好）──關節、手、圖卡──► 你的遊戲（網頁 JavaScript）
            ├ YOLO Pose：人的 17 個關節                      │
            ├ MediaPipe：手的 21 個點、手勢   機器人 ◄── /api/robot（說話、點頭）
            └ ArUco：圖卡
```

範例遊戲：

| 遊戲 | 用到什麼 | 學到什麼 |
|---|---|---|
| **舉手挑戰** | 關節 | 判斷「姿勢」（手腕比肩膀高） |
| **戳泡泡** | 關節 | 用手的「位置」做碰撞判斷、`requestAnimationFrame` 動畫、多人一起玩 |
| **圖卡問答** | 圖卡 | 認出是哪一張卡、出題與判斷對錯 |
| **跟 Zenbo 做體操（長照版）** | 關節 | 坐姿動作、手臂角度、依每個人的程度校正目標、機器人帶動作 |
| **跟機器人猜拳** | 手 | 用手勢（石頭、剪刀、布）、倒數計時、跟機器人互動 |

你只要寫 **遊戲**（`web/games/` 底下），不用碰攝影機和 YOLO。

---

## 第一次使用（三個步驟）

**事前準備**
- [VS Code](https://code.visualstudio.com/)
- [Python 3.12](https://www.python.org/downloads/)（3.10～3.13 都可以）。安裝時一定要勾選 **Add python.exe to PATH**
- 第一次要上網（下載套件，約 150 MB）
- 攝影機（沒有也可以，用示範模式）

**步驟**
1. VS Code →「檔案」→「開啟資料夾」→ 選 **`yolo-game-kit`** 這個資料夾本身（不是它的上一層）。
   右下角如果問要不要安裝建議的擴充功能，按「安裝」（Python）。
2. 按 `Ctrl+Shift+P`，輸入 `Run Task`，選 **Tasks: Run Task** →「**1. 安裝環境（第一次）**」。
   等到出現綠色的「完成！」。
3. 按 **F5**。瀏覽器會自動打開 http://127.0.0.1:8800 。

沒有攝影機：左邊「執行與偵錯」上方的下拉選單選「**示範模式（沒有攝影機）**」再按 F5。
畫面上會有一個假的骨架輪流舉左手、舉右手、雙手舉高，遊戲照樣可以玩。

停止：VS Code 上方的紅色方塊，或在終端機按 `Ctrl+C`。

---

## 資料夾

| 資料夾／檔案 | 是什麼 | 要不要改 |
|---|---|---|
| `web/games/raise-hand/` | 範例遊戲「舉手挑戰」（關節） | 可以看、可以改 |
| `web/games/bubble-pop/` | 範例遊戲「戳泡泡」（關節＋動畫） | 可以看、可以改 |
| `web/games/card-quiz/` | 範例遊戲「圖卡問答」（圖卡） | 可以看、可以改 |
| `web/games/seated-exercise/` | 範例遊戲「跟 Zenbo 做體操」（長照版，坐著做） | 可以看、可以改 |
| `web/games/rps/` | 範例遊戲「跟機器人猜拳」（手） | 可以看、可以改 |
| `web/games/_template/` | 範本：複製它來做你的遊戲 | **複製後改** |
| `cards.json` | 圖卡清單（號碼、名稱、圖案） | 要換圖卡時改 |
| `web/cards/print.html` | 列印圖卡的頁面（大廳有連結） | 不用改 |
| `web/common/pose.js` | 遊戲共用的工具（讀關節、畫骨架、叫機器人） | 不用改，拿來用 |
| `web/common/ui.js`、`style.css` | 共用的頁首、機器人對話框、樣式 | 不用改 |
| `pose_service/` | 辨識服務（Python：攝影機、YOLO、網頁伺服器） | 不用改 |
| `models/yolo11n-pose.onnx` | YOLO 姿勢模型 | 不用改 |
| `models/hand_landmarker.task` | MediaPipe 手部模型 | 不用改 |
| `config.json` | 設定：攝影機編號、連接埠、信心門檻、隱私模式 | 需要時改 |
| `robot_actions.json` | 遊戲可以叫機器人做哪些技能、冷卻時間 | 老師決定 |
| `tests/` | 測試（Tasks →「3. 跑測試」） | 不用改 |

---

## 做你自己的遊戲

1. 複製 `web/games/_template` 整個資料夾，改名，例如 `web/games/squat-counter`
   （資料夾名稱用**英文小寫和 `-`**，不要空白、不要中文）。
2. 改 `game.json`，大廳就會多一張你的卡片：
   ```json
   { "title": "深蹲計數", "description": "蹲下再站起來算一次", "icon": "🏋️", "author": "王小明", "order": 10 }
   ```
3. 改 `game.js` 的 `onPose`：判斷動作、計分。改 `index.html` 加你要的分數欄位。
4. 存檔 → 瀏覽器按 **F5** 重新整理就看得到。**不用重開伺服器**。

除錯：瀏覽器按 `F12` 打開開發者工具，`Console` 分頁會顯示錯誤；程式裡可以用 `console.log(person)` 印出關節。

---

## 關節的資料格式

每一張畫面，`onPose(people)` 會收到畫面裡的人（最多 3 個）：

```js
people = [
  {
    id: 0,                 // 0 是畫面裡最大（通常是最靠近鏡頭）的人
    score: 0.91,           // 有多確定這是一個人（0～1）
    box: [0.30, 0.10, 0.70, 0.95],        // 框住這個人：左、上、右、下
    kp: [[0.51, 0.22, 0.98], ...]         // 17 個關節，每個是 [x, y, 信心]
  }
]
```

- 座標都是 **0～1**：x 從畫面左邊（0）到右邊（1），**y 從上面（0）到下面（1），越高 y 越小**。
- `left`／`right` 是**被拍的人自己的**左右。畫面像照鏡子一樣翻轉，所以你舉左手，畫面上也是左邊動。
- 信心低於 0.3 表示看不清楚（被擋住、超出畫面），`point()` 會回傳 `null`。

17 個關節：

| 編號 | 名稱 | | 編號 | 名稱 |
|---|---|---|---|---|
| 0 | `nose` 鼻子 | | 9, 10 | `left_wrist`, `right_wrist` 手腕 |
| 1, 2 | `left_eye`, `right_eye` 眼睛 | | 11, 12 | `left_hip`, `right_hip` 髖部 |
| 3, 4 | `left_ear`, `right_ear` 耳朵 | | 13, 14 | `left_knee`, `right_knee` 膝蓋 |
| 5, 6 | `left_shoulder`, `right_shoulder` 肩膀 | | 15, 16 | `left_ankle`, `right_ankle` 腳踝 |
| 7, 8 | `left_elbow`, `right_elbow` 手肘 | | | |

---

## 手

YOLO 的關節只到手腕；要看**手指**，用 `msg.hands`（手部辨識，每隻手 21 個點）：

```js
msg.hands = [
  { side: 'right',                 // 被拍的人自己的右手（跟關節的 left／right 一樣）
    kp: [[x, y], ... 21 個],       // 0 手腕；拇指 1～4、食指 5～8、中指 9～12、無名指 13～16、小指 17～20（指根→指尖）
    fingers: [false, true, true, false, false],   // 拇指、食指、中指、無名指、小指有沒有伸直
    count: 2,                      // 伸直幾根
    gesture: 'scissors',           // rock 石頭、paper 布、scissors 剪刀、thumbs_up 讚、point 比一；認不出來是 null
    center: [0.4, 0.5], size: 0.2 }  // size：手佔畫面多高，越大越靠近
]
```

- 最多認 2 隻手（`config.json` 的 `max_hands`），最靠近鏡頭的排第一
- 手掌對著鏡頭、離鏡頭 30 公分～1 公尺最好認；手太小（太遠）會認不到
- 指尖的位置：`hand.kp[HAND.index_tip]`（食指尖）——可以拿來當滑鼠、在空中畫畫
- 不需要手的時候，把 `config.json` 的 `hands` 改成 `false`，每秒可以多跑幾張

---

## 圖卡

**先列印**：大廳的「🖨 列印圖卡」（http://127.0.0.1:8800/cards/print.html ），每頁 6 張，沿虛線剪下。

每張圖卡上面是圖案（給人看），下面是一個**黑白方塊**（ArUco 標記，給電腦看）。電腦認的是方塊，所以：
- 方塊四周的白邊不要剪掉，手指不要擋住方塊
- 印在白紙上，不要護貝（會反光）；離鏡頭 30 公分～1.5 公尺最好認
- 沒有攝影機時，示範模式會照順序輪流「拿出」每一張卡

認到的圖卡在 `onPose(people, msg)` 的 **`msg.cards`**，最靠近鏡頭的排第一：

```js
msg.cards = [
  { id: 2, name: '貓', en: 'cat', emoji: '🐱',
    corners: [[x, y], [x, y], [x, y], [x, y]],   // 方塊的四個角（0～1）
    center: [0.52, 0.40],                          // 方塊中心
    size: 0.12 }                                   // 方塊大約佔畫面多寬，越大越靠近
]
```

**換成你自己的圖卡**：改 `cards.json`，每張一行：`{"id": 12, "name": "火車", "en": "train", "emoji": "🚂"}`。
`id` 是方塊的號碼（0～49，不能重複），改完**重開伺服器**，再重新列印。

---

## pose.js 可以用的東西

```js
import { connect, createStage, point, distance, isHandUp, mainPerson, Hold,
         angle, armLift, pickPlayer, Reach,
         mainHand, GESTURES, HAND, mainCard, loadCards, Steady, robot } from '/common/pose.js';
```

| 用法 | 做什麼 |
|---|---|
| `connect({ onPose, onRobot, onHello, onStatus })` | 連到辨識服務，每張畫面呼叫 `onPose(people, msg)` |
| `createStage(element)` → `stage.draw(people, { highlight: ['left_wrist'] })` | 顯示攝影機畫面並畫骨架，`highlight` 的關節畫成黃色大點 |
| `mainPerson(people)` | 畫面裡最大的那個人（沒有人是 `null`） |
| `point(person, 'left_wrist')` | 取一個關節 `{x, y, c}`，看不清楚回傳 `null` |
| `distance(a, b)` | 兩個關節的距離 |
| `isHandUp(person, 'left')` | 手腕比肩膀高 |
| `angle(a, b, c)` | 三個關節的夾角（度），角在中間的 `b`；例如手肘打直是 180 |
| `armLift(person, 'left')` | 手臂抬多高（度）：垂下 0、平舉 90、舉到頭頂 180。只用肩膀和手腕，**坐著也能用** |
| `pickPlayer(people)` | 畫面**中間**最大的人（站在旁邊的照服員、老師不會被選到） |
| `new Reach()` → `reach.update(值)`、`reach.target(0.8, 最小, 最大)` | 量這個人最多做到多少，目標設成他自己的 8 成（校正） |
| `new Hold(500)` → `hold.update(條件)` | 條件**維持 0.5 秒**才回傳一次 `true`（防止辨識跳動誤判）；`hold.progress()` 是 0～1 的進度 |
| `stage.draw(people, { cards: msg.cards, goodCard: 2, skeleton: false })` | 畫圖卡的框和名字；`goodCard` 那張畫綠框；`skeleton: false` 不畫骨架 |
| `stage.draw(people, { hands: msg.hands })` | 畫手的骨架和手勢名稱（伸直的指尖是黃點） |
| `mainHand(msg.hands)`、`mainHand(msg.hands, 'left')` | 最靠近鏡頭的手；也可以指定左手或右手 |
| `GESTURES[hand.gesture]` | 手勢的中文和圖示，例如 `{ name: '剪刀', emoji: '✌️' }` |
| `HAND.index_tip` 等 | 手的點的編號：`wrist`、`thumb_tip`、`index_tip`、`middle_tip`、`ring_tip`、`pinky_tip` |
| `mainCard(msg.cards)` | 最靠近鏡頭的那張卡（沒有卡是 `null`） |
| `await loadCards()` | 全部圖卡的清單（`cards.json`），出題用 |
| `new Steady(600)` → `steady.update(mainCard(msg.cards)?.id)` | **同一張卡拿穩 0.6 秒**才回傳一次它的 `id`，其他時候是 `null`；判斷過的卡要拿開再拿出來才會再算 |
| `steady.ignore(id)` | 現在拿著的這張先不算（例如換題目時，還拿著上一題的卡） |
| `robot.say('你好')`、`robot.nod()`、`robot.skill('gesture.wave')` | 叫機器人說話、點頭、做技能 |
| `robot.expression('happy')`、`robot.show('做得好！')` | 換機器人的表情、在機器人螢幕上顯示大字 |

**機器人的規則**：上課時是「模擬機器人」，動作只顯示在網頁右下角。規則寫在 `robot_actions.json`：
- `skill` 只能用 `skills` 清單裡的技能（例如 `gesture.wave`、`flow.bow`）；`nod` 就是 `gesture.nod`
- `expression` 只能用 `expressions` 清單裡的表情；`show` 的字數上限和 `say` 一樣
- 同一個動作要隔 `cooldown_s` 秒（預設 0.8）才能再叫，`say` 最多 `max_say_length` 字（預設 100）
- 不要在 `onPose` 裡每一張畫面都叫機器人，要在「得分」「結束」這種時候才叫

---

## 自己訓練的物件模型（不用黑白方塊）

圖卡上沒有黑白方塊、或想直接認桌上的實物（牛奶、牙刷…），可以自己訓練 YOLO 模型：

1. 用 Roboflow 標註照片，匯出 **YOLOv8／YOLO11** 格式，解壓到 `datasets/<名稱>/`（這個資料夾不會上傳 GitHub）
2. 訓練（要另外的環境 `.venv-train`，安裝方法寫在 `tools/train_objects.py` 最上面）：
   ```
   .venv-train\Scripts\python.exe tools	rain_objects.py datasets\<名稱>\data.yaml --name cards
   ```
   做完會產生 `models/cards-yolo11n.onnx`
3. `cards.json` 加上每個類別，`en` 要跟模型的類別名稱一樣：`{"id": 12, "name": "雞蛋", "en": "egg", "emoji": "🥚"}`
4. `config.json` 加上 `"objects_model": "models/cards-yolo11n.onnx"`，重開伺服器

認到的東西會跟黑白方塊圖卡一起放在 `msg.cards`（格式一樣，多了 `box`、`score`、`"source": "yolo"`），
所以「圖卡問答」不用改就能用。黑白方塊的圖卡也還是認得到。

---

## 語音互動（用說的）

每個遊戲頁和大廳的**左下角都有 🎤 按鈕**，按一下就開始聽（瀏覽器規定要按一下才能用麥克風）。
聲音在這台電腦上用 Whisper 辨識（`pose_service/asr.py`），不會傳到網路上；中文、英文、中英混著說都可以。

| 在哪裡 | 說什麼 | 做什麼 |
|---|---|---|
| 每個遊戲 | 「開始」「再玩一次」 | 按 `id="start"` 的按鈕 |
| | 「跳過」「下一題」 | 按 `id="skip"` 的按鈕 |
| | 「再說一次」 | 按 `id="repeat"`；沒有這個按鈕就把機器人上一句再唸一次 |
| | 「重來」 | 按 `id="reset"` 的按鈕 |
| | 「回大廳」 | 回到大廳 |
| 大廳 | 遊戲名稱（「圖卡問答」「體操」「猜拳」） | 打開那個遊戲。叫法寫在 `game.json` 的 `"voice"` |
| 圖卡問答 | 卡片名稱（「雞蛋」）、「提示」 | 用說的回答、給提示 |

機器人說的話（`robot.say`）也會用電腦喇叭唸出來（模擬機器人時；接真的機器人就由機器人說）。
電腦在說話的時候不會聽，避免聽到自己的聲音。

**在你的遊戲加語音**：用上面的按鈕 id 就自動有。想多聽一些東西：
```js
import { voice } from '/common/voice.js';
voice.words(['雞蛋', '牙刷']);                        // 告訴辨識「可能會聽到這些詞」，會準很多
voice.command(['提示', '給我提示'], () => giveHint());  // 加一個指令
voice.onText((text) => { /* 指令以外的話 */ return true; });
```

---

## 設定（config.json）

| 設定 | 預設 | 說明 |
|---|---|---|
| `source` | `"auto"` | `auto`：有攝影機就用、沒有就示範模式；`camera`；`demo`；或影片檔路徑（拿錄好的影片測試） |
| `camera_index` | `0` | 攝影機編號；外接攝影機通常是 `1` |
| `show_video` | `true` | `false`＝**隱私模式**：伺服器不送出影像，網頁只看得到骨架和圖卡框（展示、拍到別人時用）。也可以 `python -m pose_service --hide-video` |
| `conf` | `0.5` | 人的信心分數低於這個就不算；常常認錯人就調高 |
| `max_people` | `3` | 最多認幾個人 |
| `device` | `"auto"` | `auto`：有顯示卡就用；`cpu`：只用 CPU |
| `hands` | `true` | 手部辨識（手指、手勢）；不需要時改 `false`，每秒可以多跑幾張 |
| `max_hands` | `2` | 最多認幾隻手 |
| `objects_model` | `null` | 自己訓練的 YOLO 物件模型（例如 `"models/cards-yolo11n.onnx"`），認沒有黑白方塊的圖卡或實物。見下面「自己訓練的物件模型」 |
| `objects_conf` | `0.5` | 物件的信心分數低於這個就不算；常常認錯就調高 |
| `asr` | `true` | 語音辨識（用說的操作遊戲）。不需要時改 `false`，就不會載入模型 |
| `asr_model` | `"small"` | Whisper 模型大小。有 NVIDIA 顯示卡用 `small`（一句約 0.4 秒）；只有 CPU 建議 `base` |
| `asr_device` | `"auto"` | `auto`：有 NVIDIA 顯示卡就用；`cpu`：只用 CPU |
| `port` | `8800` | 網頁的連接埠 |

改完 `config.json`、`cards.json`、`robot_actions.json` 都要**重開伺服器**。

---

## 想法：可以做什麼遊戲

| 遊戲 | 要用到的判斷 |
|---|---|
| 深蹲計數 | 髖部的 y 變大（蹲下）再變小（站起來） |
| 開合跳 | 兩手腕舉高＋兩腳踝距離變大 |
| 平衡挑戰 | 一隻腳的腳踝比另一隻高，維持 5 秒（`Hold`） |
| 模仿姿勢 | 畫面出現一個姿勢，比對你的關節角度 |
| 接水果 | 畫面上掉東西，用手腕的位置去接（改「戳泡泡」：泡泡改成從上面掉下來） |
| 躲避球 | 改「戳泡泡」：碰到紅色的球要扣分，用頭（`nose`）也算碰到 |
| 兩人對戰 | `people[0]` 和 `people[1]` 比誰先舉手 |
| 比數字 | 機器人說「三」，比出 3 根手指（`hand.count`） |
| 空中畫畫 | 食指尖（`hand.kp[HAND.index_tip]`）當筆，比「讚」清除畫面 |
| 手勢密碼 | 依序比出 ✊✌️🖐️ 才算過關 |
| 英文單字 | 機器人說 "cat"，拿出貓的卡（`card.en`） |
| 分類遊戲 | 「把會飛的拿出來」：鳥對、魚錯（在 `cards.json` 加一個 `type` 欄位） |
| 圖卡＋動作 | 拿著貓的卡**舉高**才算（`card.center` 的 y 比肩膀高） |
| 配對 | 同時拿出兩張有關係的卡（`msg.cards.length === 2`） |

---

## 常見問題

| 狀況 | 怎麼辦 |
|---|---|
| 「找不到 Python 3.10～3.13」 | 安裝 Python 3.12，勾選 Add python.exe to PATH，**關掉 VS Code 再打開** |
| 頁面上方出現「打不開攝影機」 | 關掉 Teams、Zoom、相機 App 這些會佔用攝影機的程式；有兩個攝影機時把 `config.json` 的 `camera_index` 改成 `1` |
| 按 F5 出現「找不到 python.exe」 | 還沒做步驟 2（安裝環境） |
| 改了遊戲沒變 | 瀏覽器按 F5 重新整理。改的是 `pose_service/`（Python）才要重開 |
| 「每秒張數」很低（低於 10） | 關掉其他吃電腦資源的程式；筆電插上電源 |
| 連接埠被佔用（8800） | `config.json` 的 `port` 改成別的數字，例如 `8801` |
| 圖卡認不到 | 黑白方塊要整個露出來、不要反光、不要太遠；白邊不要剪掉；看看是不是印到 `cards.json` 沒有的號碼 |
| 猜拳說「手部辨識沒有開」 | 重跑「1. 安裝環境」（會裝 mediapipe），或看 `config.json` 的 `hands` 是不是 `true` |
| 手勢認錯 | 手掌對著鏡頭、手指張開一點；離鏡頭近一點；背景不要太亂 |
