"""跟機器人聊天：把長輩說的話（語音辨識成文字之後）送給 Claude，拿到回答再讓機器人說出來。

  · 聲音不會送出去：語音辨識在這台電腦上做（asr.py），只有文字會送到 Anthropic 的 Claude API
  · 回答很短（一兩句），因為要用說的；用台灣的說法、繁體中文
  · 每個回答同時檢查長輩有沒有說到需要照服員注意的事（身體不舒服、跌倒、不想活了…），有就 alert=true
  · 不給醫療建議；身體的問題請長輩問照服員或醫生

要用這個功能：設定環境變數 ANTHROPIC_API_KEY，或在專案資料夾放一個 .env 檔（不會上傳 GitHub）：
  ANTHROPIC_API_KEY=sk-ant-...
"""
import json
import logging

log = logging.getLogger("pose_service")

SYSTEM = """你是日照中心裡一台陪長輩聊天的機器人，名字叫「小寶」。你說的每一句話都會用語音唸給長輩聽。

說話方式：
- 用台灣的說法、繁體中文，親切、溫暖、有耐心，像晚輩跟長輩聊天
- 每次只說一到兩句短句，全部不超過 40 個字；一次只問一個簡單的問題
- 不用表情符號、不用條列、不用英文縮寫（會被唸出來）
- 長輩說話可能斷斷續續、重複、或語音辨識有錯字：猜猜看他的意思，聽不懂就溫和地請他再說一次
- 多聊長輩熟悉的事：家鄉、年輕時的工作、拿手菜、喜歡的歌、小時候、家人、節日；多稱讚、多肯定
- 長輩說過的事，可以接著問細節，讓他多說一點
- 長輩說英文，就用簡單的英文回答

安全：
- 不給醫療、用藥、理財的建議。身體不舒服或吃藥的問題，請他告訴照服員或醫生
- 不要假裝是真人，也不要承諾做不到的事（例如幫他打電話）
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


class ChatUnavailable(Exception):
    pass


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
        system = [{"type": "text", "text": SYSTEM}]
        if name:
            system.append({"type": "text", "text": f"這位長輩請稱呼他「{name[:20]}」。"})
        if page:
            system.append({"type": "text", "text": f"長輩現在在網頁的「{page[:30]}」頁面。問到怎麼玩，就用一兩句簡單說明；不要一直提遊戲。"})
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
            return {"reply": REFUSED, "alert": False, "alert_reason": ""}
        text = next((b.text for b in resp.content if b.type == "text"), "")
        try:
            data = json.loads(text)
        except ValueError:
            log.warning("聊天回答不是 JSON（stop_reason=%s）", resp.stop_reason)
            return {"reply": "我剛剛恍神了，你可以再說一次嗎？", "alert": False, "alert_reason": ""}
        return {"reply": str(data.get("reply", "")).strip() or "嗯嗯，我在聽。",
                "alert": bool(data.get("alert")), "alert_reason": str(data.get("alert_reason", ""))}


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
