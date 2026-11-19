"""跟機器人聊天：把長輩說的話（語音辨識成文字之後）送給 Claude，拿到回答再讓機器人說出來。

  · 聲音不會送出去：語音辨識在這台電腦上做（asr.py），只有文字會送到 Anthropic 的 Claude API
  · 回答很短（一兩句），因為要用說的；用台灣的說法、繁體中文
  · 每個回答同時檢查長輩有沒有說到需要照服員注意的事（身體不舒服、跌倒、不想活了…），有就 alert=true
  · 不給醫療建議；身體的問題請長輩問照服員或醫生

兩種「大腦」（config.json 的 chat_provider）：
  · local：本機模型（Ollama），不用金鑰、不用網路，文字也不會離開這台電腦。要先安裝 Ollama 並下載模型（見 README）
  · claude：Anthropic 的 Claude API，回答最好，要設定 ANTHROPIC_API_KEY（放在專案的 .env 檔，不會上傳 GitHub）
不管用哪一種，都另外用關鍵字檢查「需要照服員注意」的話（模型可能漏掉）。
"""
import json
import logging
import re
import urllib.error
import urllib.request

log = logging.getLogger("pose_service")

SYSTEM = """你是日照中心裡一台陪長輩聊天的機器人，名字叫「小寶」。你說的每一句話都會用語音唸給長輩聽。

說話方式：
- 用台灣的說法、繁體中文，親切、溫暖、有耐心，像晚輩跟長輩聊天
- 每次只說一到兩句短句，全部不超過 40 個字；一次只問一個簡單的問題
- 不用表情符號、不用條列、不用英文縮寫（會被唸出來）
- 長輩說話可能斷斷續續、重複、或語音辨識有錯字：猜猜看他的意思，聽不懂就溫和地請他再說一次
- 多聊長輩熟悉的事：家鄉、年輕時的工作、拿手菜、喜歡的歌、小時候、家人、節日；多稱讚、多肯定
- 長輩說過的事，可以接著問細節，讓他多說一點
- 長輩說英文，就用簡單的英文回答；長輩說中文時，回答裡不要夾雜任何英文單字

安全：
- 不給醫療、用藥、理財的建議。身體不舒服或吃藥的問題，請他告訴照服員或醫生
- 不要假裝是真人。你只能聊天：不能打電話、放音樂、叫人、找東西，也不要說「我幫你…」；需要的話請他告訴照服員
- 如果長輩提到身體不舒服（胸痛、喘不過氣、頭暈、跌倒、受傷）、想傷害自己或不想活了、被欺負、或很害怕：
  溫和地安慰他、請他告訴身邊的照服員，並且把 alert 設成 true，alert_reason 用一句話寫給照服員看
- 其他時候 alert 是 false，alert_reason 是空字串"""

SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string", "description": "要唸給長輩聽的話，一到兩句，不超過 40 個字"},
        "alert": {"type": "boolean", "description": "需要照服員注意時為 true"},
        "alert_reason": {"type": "string", "description": "給照服員看的一句話；不需要注意時是空字串"},
    },
    "required": ["reply", "alert", "alert_reason"],
    "additionalProperties": False,
}

REFUSED = "這個我不太會回答，我們聊聊別的好不好？你最近有沒有吃到什麼好吃的？"
MAX_TURNS = 30           # 最多帶最近幾則對話（太長會變慢、變貴）
MAX_CHARS = 500          # 每一則最多幾個字
MAX_REPLY = 60           # 小寶一次最多說幾個字
KEEP_ALIVE = "24h"       # 本機模型放在顯示卡裡多久不卸載


# 關鍵字安全網：模型（特別是本機的小模型）可能漏掉，聽到這些字一定提醒照服員
ALERT_WORDS = ["胸口痛", "胸痛", "胸悶", "心臟痛", "喘不過氣", "呼吸困難", "吸不到氣", "頭很暈", "頭暈", "暈倒",
               "跌倒", "摔倒", "摔跤", "跌了一跤", "滑倒", "滑了一跤", "受傷", "流血", "不想活", "想死", "死了算了", "活著沒意思", "自殺",
               "救命", "被打", "被欺負", "好害怕", "很害怕", "吃錯藥", "藥吃太多",
               "活著好累", "活得好累", "大家的負擔", "是個負擔", "拖累", "沒有用了", "沒人要我", "一個人好孤單"]


class ChatUnavailable(Exception):
    pass


def keyword_alert(text):
    """長輩說的話裡有需要照服員注意的字：回傳提醒文字，沒有就回傳空字串"""
    hits = [w for w in ALERT_WORDS if w in text]
    return f"長輩提到「{hits[0]}」：{text[:40]}" if hits else ""


# 每一頁怎麼玩（長輩問「這個怎麼玩」時照這個說，模型才不會自己編）
PAGE_HELP = {
    "大廳": "這裡是大廳，說遊戲的名字（例如「圖卡問答」「舉手」「猜拳」「體操」）就可以開始玩。",
    "圖卡問答": "機器人說要哪一張卡，就把那張圖卡拿到鏡頭前面拿穩一下；拿不動的話，直接說出卡片的名字也可以。想不起來可以說「提示」。",
    "舉手挑戰": "照畫面上的指示舉左手、右手或雙手，手舉到肩膀高、停一秒就算，坐著做就可以。藍色是左手、橘色是右手。",
    "戳泡泡": "畫面上會有泡泡飄上來，用手去碰泡泡就能戳破。",
    "跟機器人猜拳": "喊「剪刀、石頭、布」之後，對著鏡頭出拳，機器人也會出。",
    "跟 Zenbo 做體操": "坐著跟著機器人做上肢體操，先暖身量你的手能舉多高，照自己的程度做就好。",
}


def system_text(name="", page=""):
    out = SYSTEM
    if name:
        out += f"\n\n這位長輩請稱呼他「{name[:20]}」。"
    if page:
        help_text = next((v for k, v in PAGE_HELP.items() if k in page), "")
        out += f"\n\n長輩現在在網頁的「{page[:30]}」頁面。" + (f"這一頁的玩法：{help_text}" if help_text else "")
        out += "問到怎麼玩，就照玩法用一兩句簡單說明，不要自己編；沒問就不要一直提遊戲。"
    return out


def finish(data, messages):
    """整理模型的回答，再加上關鍵字安全網"""
    reply = str(data.get("reply", "")).strip() or "嗯嗯，我在聽。"
    if len(reply) > MAX_REPLY:              # 太長（小模型偶爾會）：在句子結尾切掉，機器人不會一直說
        cut = max(reply.rfind(c, 0, MAX_REPLY) for c in "。！？!?")
        reply = reply[:cut + 1] if cut > 10 else reply[:MAX_REPLY]
    out = {"reply": reply,
           "alert": bool(data.get("alert")), "alert_reason": str(data.get("alert_reason", ""))}
    kw = keyword_alert(messages[-1]["content"])
    if kw and not out["alert"]:
        out["alert"], out["alert_reason"] = True, kw
    return out


def make_bot(cfg):
    """照 config.json 的 chat_provider 做出聊天的「大腦」"""
    if cfg.get("chat_provider", "local") == "claude":
        return ChatBot(cfg.get("chat_model", "claude-opus-5-5"), cfg.get("chat_effort", "low"))
    return LocalChatBot(cfg.get("local_model", "qwen2.5:7b"), cfg.get("ollama_url", "http://127.0.0.1:11434"))


class ChatBot:
    def __init__(self, model="claude-opus-5-5", effort="low"):
        try:
            import anthropic
        except ImportError:
            raise ChatUnavailable("沒有安裝 anthropic 套件，請重跑「1. 安裝環境」")
        self.anthropic = anthropic
        self.model = model
        self.effort = effort         # 聊天不需要想很久：low 回得比較快
        self.client = None
        self.label = f"聊天（Claude，{model}）"

    def _client(self):
        if self.client is None:
            try:
                self.client = self.anthropic.Anthropic()
            except self.anthropic.AnthropicError:
                raise ChatUnavailable("還沒設定 ANTHROPIC_API_KEY（放在專案資料夾的 .env 檔，見 README）")
        return self.client

    def reply(self, history, name="", page=""):
        """history：[{"role": "user"|"assistant", "content": "..."}]，最後一則要是 user。
        回傳 {"reply": "...", "alert": bool, "alert_reason": "..."}"""
        messages = _clean(history)
        if not messages or messages[-1]["role"] != "user":
            raise ValueError("最後一則要是長輩說的話")
        system = system_text(name, page)
        a = self.anthropic
        try:
            resp = self._client().beta.messages.create(
                model=self.model,
                max_tokens=4000,
                # 安全分類器拒答時，自動改用合適的模型再試（不用自己維護模型清單）
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                system=system,
                messages=messages,
                output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": SCHEMA}},
            )
        except TypeError as e:              # 完全沒有設定金鑰時，SDK 送出請求前會丟這個
            if "authentication" in str(e).lower():
                raise ChatUnavailable("還沒設定 ANTHROPIC_API_KEY（放在專案資料夾的 .env 檔，見 README）")
            raise
        except a.AuthenticationError:
            raise ChatUnavailable("API key 不對，請檢查 .env 裡的 ANTHROPIC_API_KEY")
        except a.PermissionDeniedError:
            raise ChatUnavailable("這個 API key 沒有使用這個模型的權限")
        except a.RateLimitError:
            raise ChatUnavailable("用得太頻繁了，等一下再說")
        except a.APIConnectionError:
            raise ChatUnavailable("連不上網路，請檢查網路")
        except a.APIStatusError as e:
            raise ChatUnavailable(f"聊天服務暫時有問題（{e.status_code}），等一下再試")

        if resp.stop_reason == "refusal":
            return finish({"reply": REFUSED}, messages)
        text = next((b.text for b in resp.content if b.type == "text"), "")
        try:
            data = json.loads(text)
        except ValueError:
            log.warning("聊天回答不是 JSON（stop_reason=%s）", resp.stop_reason)
            data = {"reply": "我剛剛恍神了，你可以再說一次嗎？"}
        return finish(data, messages)


class LocalChatBot:
    """本機模型（Ollama）：不用金鑰、不用網路。Ollama 要先安裝、在背景執行，並下載模型（ollama pull qwen2.5:7b）"""

    def __init__(self, model="qwen2.5:7b", url="http://127.0.0.1:11434"):
        self.model, self.url = model, url.rstrip("/")
        self.label = f"聊天（本機 {model}）"
        # 第一次把模型載入顯示卡要幾十秒：伺服器一啟動就在背景先載入，長輩第一句話才不會等很久
        import threading
        threading.Thread(target=self._warm_up, daemon=True).start()
        try:
            import opencc
            self.cc = opencc.OpenCC("s2twp")   # 有些模型會冒出簡體字：一律轉成台灣繁體
        except ImportError:
            self.cc = None

    def reply(self, history, name="", page=""):
        messages = _clean(history)
        if not messages or messages[-1]["role"] != "user":
            raise ValueError("最後一則要是長輩說的話")
        body = {
            "model": self.model, "stream": False, "keep_alive": KEEP_ALIVE,   # 一直放在顯示卡裡，每句都快
            "messages": [{"role": "system", "content": system_text(name, page)}] + messages,
            "format": SCHEMA,                                          # 要模型照格式回答（JSON）
            "options": {"temperature": 0.7, "num_predict": 200},
        }
        out = self._post(body)
        data = self._parse(out)
        # 小模型偶爾會在中文裡夾雜英文單字：長輩沒說英文的話，重問一次（溫度低一點），還是有就把英文拿掉
        user_english = re.search(r"[A-Za-z]{3,}", messages[-1]["content"])
        if not user_english and re.search(r"[A-Za-z]{3,}", data.get("reply", "")):
            body["options"]["temperature"] = 0.3
            try:
                data = self._parse(self._post(body))
            except ChatUnavailable:
                pass
            if re.search(r"[A-Za-z]{3,}", data.get("reply", "")):
                data["reply"] = re.sub(r"\s*[A-Za-z][A-Za-z' ]*[A-Za-z]\s*", "", data["reply"])
        if self.cc:
            data["reply"] = self.cc.convert(str(data.get("reply", "")))
            data["alert_reason"] = self.cc.convert(str(data.get("alert_reason", "")))
        return finish(data, messages)

    def _post(self, body):
        req = urllib.request.Request(f"{self.url}/api/chat", data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:      # 第一次要把模型載入顯示卡，比較久
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:200]
            if e.code == 404:
                raise ChatUnavailable(f"本機還沒有模型 {self.model}，請先執行：ollama pull {self.model}")
            raise ChatUnavailable(f"本機模型出錯（{e.code}）：{detail}")
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            raise ChatUnavailable(f"連不到本機模型（Ollama 有沒有開？）：{e}")

    def _warm_up(self):
        req = urllib.request.Request(f"{self.url}/api/generate", headers={"Content-Type": "application/json"},
                                     data=json.dumps({"model": self.model, "keep_alive": KEEP_ALIVE}).encode("utf-8"))
        for attempt in range(2):
            try:
                with urllib.request.urlopen(req, timeout=300):
                    log.info("本機聊天模型 %s 已經載入", self.model)
                return
            except urllib.error.URLError as e:
                # 連不到：Ollama 可能沒在跑（例如剛開機）。試著幫忙啟動一次
                if attempt == 0 and isinstance(e.reason, ConnectionError) and _start_ollama():
                    continue
                log.warning("本機聊天模型 %s 還不能用：%s", self.model, e)
                return
            except Exception as e:                      # 還沒下載模型等：聊天時會再說明
                log.warning("本機聊天模型 %s 還不能用：%s", self.model, e)
                return

    @staticmethod
    def _parse(out):
        text = out.get("message", {}).get("content", "")
        try:
            data = json.loads(text)
            return data if isinstance(data, dict) else {"reply": str(data)}
        except ValueError:
            return {"reply": text.strip()[:80]}       # 沒照格式：直接拿文字當回答


def _start_ollama():
    """Ollama 沒在跑的時候，在背景啟動它（只在這台電腦的 127.0.0.1）。成功回傳 True"""
    import os
    import shutil
    import subprocess
    import time
    exe = shutil.which("ollama") or os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Ollama", "ollama.exe")
    if not os.path.exists(exe):
        return False
    env = dict(os.environ)
    if os.name == "nt" and "OLLAMA_MODELS" not in env:    # 模型放在別的磁碟（使用者環境變數）：也要帶過去
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
                env["OLLAMA_MODELS"] = winreg.QueryValueEx(k, "OLLAMA_MODELS")[0]
        except OSError:
            pass
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen([exe, "serve"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
    log.info("Ollama 沒在跑，已經在背景啟動它")
    time.sleep(5)
    return True


def _clean(history):
    """只留 user／assistant 的文字、最近 MAX_TURNS 則，第一則要是 user"""
    out = []
    for m in history[-MAX_TURNS:] if isinstance(history, list) else []:
        role, content = m.get("role"), str(m.get("content", "")).strip()[:MAX_CHARS]
        if role in ("user", "assistant") and content:
            out.append({"role": role, "content": content})
    while out and out[0]["role"] != "user":
        out.pop(0)
    return out
