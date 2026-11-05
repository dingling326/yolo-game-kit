# 協作說明

這份文件寫給專題的組員：誰負責哪些檔案、怎麼用分支和 Pull Request（PR）合作、畫面和程式之間的「id 約定」。

---

## 1. 分工：誰改哪些檔案

| 負責 | 檔案 |
|---|---|
| **UI** | `web/games/<遊戲>/index.html`（畫面配置、文字、按鈕） |
| | `web/games/<遊戲>/style.css`（這個遊戲的顏色、字體、動畫） |
| | `web/common/style.css`（所有遊戲共用的樣式） |
| | `web/index.html`（大廳）、`web/cards/print.html`（列印圖卡） |
| **開發** | `web/games/<遊戲>/game.js`（遊戲規則、判斷、計分、難度） |
| | `web/common/pose.js`、`web/common/ui.js` |
| | `pose_service/`（Python：辨識、LLM、紀錄）、`tests/` |
| | `cards.json`、`config.json`、`robot_actions.json`、`requirements.txt` |

- 盡量只改自己負責的檔案，**兩個人改同一個檔案才會衝突**
- 需要改對方的檔案時，先在群組說一聲，或開一個 Issue 請對方改
- `.github/CODEOWNERS` 會在 PR 動到對方的檔案時，自動請對方審核

---

## 2. id 約定：畫面和程式怎麼接起來

`game.js` 用 `id` 找到畫面上的元素再改內容，例如 `$('task').textContent = '請拿出牛奶'`。

**UI 的規則**
- 排版、顏色、字體、圖片、動畫都可以隨意改
- 下面表格裡的 **id 不能刪除、不能改名**。元素可以搬位置、可以換標籤（例如 `div` 換成 `p`）
- 表格裡的 **class** 是 `game.js` 會加上或拿掉的，可以改它的樣式，但不要改名

**開發的規則**
- 需要新的畫面元素（例如「目前難度」），請 UI 加 id，再把它補進下面的表格
- 不要在 `game.js` 裡寫顏色、字體這類樣式，改成加或拿掉 class，樣式交給 UI 寫在 `style.css`

每個遊戲都會用到的 id：`stage`（攝影機畫面）、`robot`（機器人對話框）、`big`（畫面中間的大字）

| 遊戲 | game.js 用到的 id | game.js 會切換的 class |
|---|---|---|
| `card-quiz` 圖卡問答（長輩版） | `progress` `task` `pic` `clue` `task-card` `hold` `seen` `start` `repeat` `skip` `count` `deck` `setup` `summary` `results` | `#task-card.flash`、`#task-card.hinting`、`#big.good`、`#big.soft`；`#deck` 裡的 `button.off`；`#results` 裡的 `li.skipped` |
| `raise-hand` 舉手挑戰 | `task` `task-card` `hold` `score` `best` `time` `time-text` `start` | `#task-card.flash` |
| `bubble-pop` 戳泡泡 | `task` `hold` `score` `best` `time` `time-text` `start` | |
| `rps` 猜拳 | `task` `hold` `seen` `you` `bot` `you-pts` `bot-pts` `result` `history` `start` | `#result.win`、`#result.lose`；`#history` 裡的 `span.w`、`span.l` |
| `seated-exercise` 體操 | `task` `task-card` `sub` `hint` `hold` `phase` `level` `steps` `start` `skip` | `#task-card.flash`；`#steps` 裡的 `li.now`、`li.done` |
| `_template` 範本 | `count` `debug` `reset` | |

新增遊戲時，請把它的 id 補進這張表。

---

## 3. 不用攝影機也能測試

VS Code 左邊「執行與偵錯」的下拉選單選 **示範模式（沒有攝影機）**，再按 F5。
畫面上會有假的骨架、假的手勢，假的圖卡每 3 秒換一張，遊戲會照樣出題和判斷。調整畫面時用這個最方便。

改了 html、css、js，瀏覽器按 F5 重新整理就看得到，不用重開伺服器。

---

## 4. 每次做一件事的流程

`main` 永遠保持「可以跑」的版本，**不要直接在 main 上改**。

```bash
# ① 從最新的 main 開分支（UI 用 ui/ 開頭，開發用 feature/ 開頭，修錯用 fix/ 開頭）
git checkout main
git pull
git checkout -b ui/題目卡片

# ② 改檔案、測試；可以 commit 好幾次
git add .
git commit -m "題目卡片：字體放大、加圓角"

# ③ 上傳分支
git push -u origin ui/題目卡片
```

④ 到 GitHub 專案頁按 **Compare & pull request**，照範本填寫（UI 的改動一定要附截圖），右邊 Reviewers 選對方
⑤ 對方看過後按 **Approve**，再按 **Merge pull request**
⑥ 合併後回到 main 更新，並刪掉做完的分支：

```bash
git checkout main
git pull
git branch -d ui/題目卡片
```

不想打指令：VS Code 左下角點分支名稱可以建立、切換分支；左邊「原始檔控制」（`Ctrl+Shift+G`）可以 commit、同步。

---

## 5. 有衝突怎麼辦

PR 顯示 **This branch has conflicts** 時：

```bash
git checkout 你的分支
git pull origin main
```

VS Code 會標出衝突的地方，選 **Accept Current**（留自己的）、**Accept Incoming**（留 main 的）或 **Accept Both**（兩個都留）。存檔後 `git add .`、`git commit`、`git push`，PR 就會更新。

不確定要留哪一邊，就找對方一起看。

---

## 6. 不能上傳的東西

- **API 金鑰、密碼**：放在 `.env`（已經被 `.gitignore` 排除），程式用環境變數讀
- **長者的照片、影片、真實姓名**：測試資料用代號（例如 A01），訓練紀錄放 `data/`（不會上傳）
- **超過 100 MB 的檔案**（例如自己訓練的模型）：用雲端硬碟分享，或改用 Git LFS
