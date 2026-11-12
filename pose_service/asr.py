"""語音辨識（ASR）：用 faster-whisper（Whisper 的加速版）在這台電腦上把聲音轉成文字，聲音不會傳到網路上。

網頁（web/common/voice.js）負責錄音、判斷「有人在說話」，說完一句就把聲音送到 POST /api/asr，這裡回傳文字。

  · 中英文都可以，也可以混著說（「我要玩 card quiz」）
  · 輸出一律轉成台灣繁體（OpenCC s2twp）
  · 有 NVIDIA 顯示卡：一句話約 0.4 秒（GTX 1070 測過）。只有 CPU：small 模型一句要好幾秒，建議改用 base
  · 網頁可以傳「這一頁可能會聽到的詞」（prompt），例如圖卡名稱、按鈕名稱，辨識會準很多

模型第一次用會從網路下載（small 約 480 MB），之後就不用網路。
"""
import glob
import io
import logging
import os
import sys
import threading
import time
import wave

import numpy as np

log = logging.getLogger("pose_service")

# Whisper 在沒有人說話（只有雜音）時，常常會「腦補」出這些影片字幕常見的句子，聽到就當作沒聽到
HALLUCINATIONS = ("字幕", "訂閱", "按讚", "謝謝觀看", "感謝觀看", "謝謝大家", "請不吝", "點贊", "明鏡", "優優獨播")
BASE_PROMPT = "以下是繁體中文，可能夾雜英文。"


def _add_cuda_dlls():
    """Windows：pip 裝的 nvidia-cublas-cu12、nvidia-cudnn-cu12 的 DLL 要先加進搜尋路徑，顯示卡才用得到"""
    if os.name != "nt":
        return
    for d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
        os.add_dll_directory(d)
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


class AsrUnavailable(Exception):
    pass


class WhisperASR:
    def __init__(self, model="small", device="auto"):
        try:
            _add_cuda_dlls()
            import ctranslate2
            import faster_whisper  # noqa: F401
            import opencc
        except ImportError as e:
            raise AsrUnavailable(f"沒有安裝語音辨識套件（{e.name}），請重跑「1. 安裝環境」")
        self.model_name = model
        if device == "auto":
            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        self.device = device
        self.cc = opencc.OpenCC("s2twp")
        self.model = None
        self.error = None
        self.lock = threading.Lock()            # 一次只辨識一句（顯示卡只有一張）
        self.ready = threading.Event()
        self.label = f"語音 Whisper {model}（{'顯示卡' if device == 'cuda' else 'CPU'}，載入中…）"
        # 載入模型要幾秒到幾十秒（第一次還要下載），放到背景做，不要卡住伺服器啟動
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self):
        from faster_whisper import WhisperModel
        t = time.perf_counter()
        try:
            try:
                self.model = WhisperModel(self.model_name, device=self.device, compute_type="int8")
            except Exception as e:
                if self.device != "cuda":
                    raise
                log.warning("語音辨識用不了顯示卡（%s），改用 CPU，會比較慢", e)
                self.device = "cpu"
                self.model = WhisperModel(self.model_name, device="cpu", compute_type="int8")
            # 暖身：第一次辨識特別慢，先跑一次空白聲音
            list(self.model.transcribe(np.zeros(16000, dtype=np.float32), language="zh")[0])
            self.label = f"語音 Whisper {self.model_name}（{'顯示卡' if self.device == 'cuda' else 'CPU'}）"
            log.info("語音辨識載入完成：%s（%.0f 秒）", self.label, time.perf_counter() - t)
        except Exception as e:
            self.error = str(e)
            self.label = "語音辨識載入失敗"
            log.exception("語音辨識載入失敗")
        finally:
            self.ready.set()

    def transcribe(self, wav_bytes, prompt=""):
        """wav_bytes：16 kHz、單聲道、16 bit 的 WAV。回傳 {"text": "...", "ms": 辨識花了幾毫秒}"""
        if not self.ready.is_set():
            raise AsrUnavailable("語音辨識還在載入，等一下再說")
        if self.model is None:
            raise AsrUnavailable(f"語音辨識載入失敗：{self.error}")
        audio = _read_wav(wav_bytes)
        if len(audio) < 16000 * 0.2:            # 不到 0.2 秒：不算一句話
            return {"text": "", "ms": 0}
        t = time.perf_counter()
        with self.lock:
            segments, _ = self.model.transcribe(
                audio, language="zh", beam_size=1, condition_on_previous_text=False,
                initial_prompt=BASE_PROMPT + (prompt or ""),
                vad_filter=True, vad_parameters={"min_silence_duration_ms": 500})
            parts = [s.text for s in segments if s.no_speech_prob < 0.6]
        text = self.cc.convert("".join(parts).strip())
        if any(h in text for h in HALLUCINATIONS):
            text = ""
        return {"text": text, "ms": round((time.perf_counter() - t) * 1000)}


def _read_wav(data):
    with wave.open(io.BytesIO(data)) as w:
        if w.getsampwidth() != 2:
            raise ValueError("WAV 要是 16 bit")
        frames = w.readframes(w.getnframes())
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        if w.getnchannels() > 1:
            audio = audio.reshape(-1, w.getnchannels()).mean(axis=1)
        rate = w.getframerate()
    if rate != 16000:                           # 網頁應該已經轉好 16 kHz；不是的話簡單重新取樣
        n = int(len(audio) * 16000 / rate)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    return audio
