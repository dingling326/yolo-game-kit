"""網頁伺服器（aiohttp）：

  GET  /                 遊戲大廳（web/index.html）
  GET  /games/<遊戲>/...  各遊戲的網頁
  GET  /common/...       共用的 pose.js、ui.js、style.css
  GET  /api/games        遊戲清單（讀 web/games/*/game.json）
  GET  /api/status       狀態：影像來源、模型、機器人、每秒幾張
  GET  /api/cards        圖卡清單（cards.json）
  GET  /api/cards/<id>/marker.png  圖卡的標記圖（列印用）
  GET  /cards/print.html 列印圖卡
  GET  /video.mjpg       攝影機畫面（MJPEG 串流）
  GET  /ws               WebSocket：每一張畫面送一則 {"type": "pose", "people": [...], "cards": [...], "hands": [...]}，
                         機器人動作送 {"type": "robot", ...}
  POST /api/robot        叫機器人做事 {"action": "say", "text": "..."}
  POST /api/asr          語音辨識：送 16 kHz 單聲道 WAV（?prompt=這頁可能會聽到的詞），回傳 {"ok": true, "text": "..."}

攝影機、YOLO、圖卡辨識在背景執行緒跑，網頁伺服器在 asyncio 迴圈跑，用 call_soon_threadsafe 把結果交過來。
"""
import asyncio
import json
import logging
import mimetypes
import threading
import time
from types import SimpleNamespace

import cv2
from aiohttp import web

from . import asr, config, hands, keypoints
from .cards import CardDetector, DemoCards, load_cards, marker_png
from .detector import DemoPose, YoloPose
from .objects import CombinedCards, YoloObjects
from .robot import MockRobot, RobotGuard, RobotRefused, make_robot
from .sources import open_source

log = logging.getLogger("pose_service")
# Windows 的 Python 有時候不認得 webp，圖片會被當成一般檔案。aiohttp 新版有自己的一份對照表，兩邊都加
mimetypes.add_type("image/webp", ".webp")
try:
    from aiohttp import web_fileresponse
    web_fileresponse.CONTENT_TYPES.add_type("image/webp", ".webp")
except (ImportError, AttributeError):
    pass
WEB = config.ROOT / "web"
CTX = web.AppKey("ctx", SimpleNamespace)     # 伺服器的狀態：影像來源、辨識、機器人、hub


class Client:
    """一個 WebSocket 連線。姿勢只留最新的一則（網路慢就跳過舊的），機器人事件一則都不丟"""

    def __init__(self):
        self.pose = None
        self.events = []
        self.wake = asyncio.Event()


class Hub:
    def __init__(self):
        self.clients = set()
        self.jpeg = None
        self.fps = 0.0
        self.frame_ready = asyncio.Event()

    def publish(self, msg, jpeg):
        """背景執行緒每辨識完一張就呼叫一次（在 asyncio 迴圈裡執行）"""
        self.jpeg = jpeg
        self.fps = msg["fps"]
        ready, self.frame_ready = self.frame_ready, asyncio.Event()
        ready.set()
        data = json.dumps(msg, ensure_ascii=False)
        for c in self.clients:
            c.pose = data
            c.wake.set()

    def event(self, msg):
        data = json.dumps(msg, ensure_ascii=False)
        for c in self.clients:
            c.events.append(data)
            c.wake.set()


def capture_loop(stop, source, detector, modules, hub, loop, show_video=True):
    """modules：其他辨識模組 {"cards": 圖卡, "hands": 手部}，結果放在訊息裡同名的欄位。要加新的辨識，加在這裡就好"""
    fps, prev = 0.0, time.perf_counter()
    misses = 0
    while not stop.is_set():
        frame = source.read()
        if frame is None:
            misses += 1
            if misses == 30:
                log.warning("讀不到畫面了（攝影機被拔掉或被別的程式拿走？）")
            time.sleep(0.05)
            continue
        misses = 0
        try:
            people = detector.detect(frame)
        except Exception:
            log.exception("辨識失敗")
            people = []
        extra = {}
        for key, module in modules.items():
            try:
                extra[key] = module.detect(frame)
            except Exception:
                log.exception("%s 辨識失敗", module.label)
                extra[key] = []
        now = time.perf_counter()
        fps = 0.9 * fps + 0.1 / max(now - prev, 1e-3) if fps else 1 / max(now - prev, 1e-3)
        prev = now
        h, w = frame.shape[:2]
        # 隱私模式：影像不編碼、不送出，畫面只留在這台電腦的記憶體裡
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70]) if show_video else (False, None)
        msg = {"type": "pose", "t": round(time.time(), 3), "fps": round(fps, 1), "w": w, "h": h,
               "people": people, "cards": [], "hands": [], **extra}
        loop.call_soon_threadsafe(hub.publish, msg, buf.tobytes() if ok else None)


# ---------------------------------------------------------------- 網頁

@web.middleware
async def no_cache(request, handler):
    """改了遊戲程式按重新整理就看得到，不會被瀏覽器快取住"""
    resp = await handler(request)
    if not request.path.startswith(("/video", "/ws")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


async def index(request):
    return web.FileResponse(WEB / "index.html")


async def games(request):
    out = []
    for d in sorted((WEB / "games").iterdir()):
        meta = d / "game.json"
        if not meta.is_file():
            continue
        try:
            info = json.loads(meta.read_text(encoding="utf-8"))
        except ValueError as e:
            info = {"title": d.name, "description": f"game.json 格式錯誤：{e}"}
        info.update(id=d.name, url=f"/games/{d.name}/index.html", template=d.name.startswith("_"))
        out.append(info)
    out.sort(key=lambda g: (g["template"], g.get("order", 99), g["id"]))
    return web.json_response(out)


async def status(request):
    app = request.app[CTX]
    return web.json_response({
        "source": app.source.label, "source_kind": app.source.kind,
        "detector": app.detector.label, "robot": app.robot.label, "robot_mode": app.robot.mode,
        "fps": app.hub.fps, "clients": len(app.hub.clients), "notice": app.notice,
        "modules": {k: m.label for k, m in app.modules.items()},
        "show_video": app.cfg.get("show_video", True),
        "asr": app.asr.label if app.asr else None,
    })


async def card_list_api(request):
    return web.json_response(request.app[CTX].card_list)


async def card_marker(request):
    try:
        card_id = int(request.match_info["id"])
    except ValueError:
        raise web.HTTPNotFound()
    if card_id not in {c["id"] for c in request.app[CTX].card_list}:
        raise web.HTTPNotFound()
    return web.Response(body=marker_png(card_id), content_type="image/png")


async def video(request):
    if not request.app[CTX].cfg.get("show_video", True):
        raise web.HTTPForbidden(text="隱私模式：不送出影像（config.json 的 show_video）")
    hub = request.app[CTX].hub
    resp = web.StreamResponse(headers={"Content-Type": "multipart/x-mixed-replace; boundary=frame",
                                       "Cache-Control": "no-store"})
    await resp.prepare(request)
    try:
        while True:
            await hub.frame_ready.wait()
            if hub.jpeg:
                await resp.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(hub.jpeg)
                                 + hub.jpeg + b"\r\n")
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    return resp


async def websocket(request):
    app = request.app[CTX]
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    client = Client()
    app.hub.clients.add(client)
    await ws.send_json({"type": "hello", "names": keypoints.NAMES, "skeleton": keypoints.SKELETON,
                        "source": app.source.label, "source_kind": app.source.kind,
                        "detector": app.detector.label, "robot": app.robot.label,
                        "robot_mode": app.robot.mode, "modules": {k: m.label for k, m in app.modules.items()},
                        "hand_connections": hands.CONNECTIONS, "show_video": app.cfg.get("show_video", True),
                        "asr": app.asr.label if app.asr else None},
                       dumps=lambda o: json.dumps(o, ensure_ascii=False))

    async def sender():
        while not ws.closed:
            await client.wake.wait()
            client.wake.clear()
            events, client.events = client.events, []
            for data in events:
                await ws.send_str(data)
            if client.pose:
                data, client.pose = client.pose, None
                await ws.send_str(data)

    task = asyncio.create_task(sender())
    try:
        async for _ in ws:      # 網頁不用送東西過來；收到就忽略
            pass
    finally:
        task.cancel()
        app.hub.clients.discard(client)
    return ws


async def robot_api(request):
    app = request.app[CTX]
    try:
        body = await request.json()
    except ValueError:
        return web.json_response({"ok": False, "error": "要送 JSON"}, status=400)
    action, text, name = body.get("action"), body.get("text", ""), body.get("name", "")
    try:
        # 接平台時要等網路，放到執行緒做，不卡住影像串流
        result = await asyncio.get_running_loop().run_in_executor(None, app.guard.run, action, text, name)
    except RobotRefused as e:
        app.hub.event({"type": "robot", "ok": False, "action": action, "error": str(e)})
        return web.json_response({"ok": False, "error": str(e)})
    app.hub.event({"type": "robot", "ok": True, "action": action, "result": result,
                   "text": text if action == "say" else "", "robot_mode": app.robot.mode})
    return web.json_response({"ok": True, "result": result})


async def asr_api(request):
    app = request.app[CTX]
    if app.asr is None:
        return web.json_response({"ok": False, "error": "語音辨識沒有開（config.json 的 asr）"})
    data = await request.read()
    if not data or len(data) > 5_000_000:
        return web.json_response({"ok": False, "error": "聲音太長或是空的"}, status=400)
    prompt = request.query.get("prompt", "")[:300]
    try:
        # 辨識要幾百毫秒，放到執行緒做，不卡住影像串流
        out = await asyncio.get_running_loop().run_in_executor(None, app.asr.transcribe, data, prompt)
    except asr.AsrUnavailable as e:
        return web.json_response({"ok": False, "error": str(e)})
    except Exception as e:
        log.exception("語音辨識失敗")
        return web.json_response({"ok": False, "error": f"語音辨識失敗：{e}"})
    return web.json_response({"ok": True, **out})


def build_app(cfg, source, detector, robot, notice=None, modules=None, card_list=None, asr_engine=None):
    """modules：其他辨識模組 {"cards": ..., "hands": ...}（沒給＝只認姿勢）；card_list：圖卡清單，沒給就讀 cards.json"""
    modules = modules or {}
    app = web.Application(middlewares=[no_cache])
    ctx = app[CTX] = SimpleNamespace(cfg=cfg, source=source, detector=detector, robot=robot,
                                     guard=RobotGuard(robot), notice=notice, hub=None, modules=modules, asr=asr_engine,
                                     card_list=card_list if card_list is not None else load_cards())
    app.router.add_get("/", index)
    app.router.add_get("/api/games", games)
    app.router.add_get("/api/status", status)
    app.router.add_get("/api/cards", card_list_api)
    app.router.add_get("/api/cards/{id}/marker.png", card_marker)
    app.router.add_get("/video.mjpg", video)
    app.router.add_get("/ws", websocket)
    app.router.add_post("/api/robot", robot_api)
    app.router.add_post("/api/asr", asr_api)
    app.router.add_static("/common", WEB / "common")
    app.router.add_static("/games", WEB / "games")
    app.router.add_static("/cards", WEB / "cards")

    async def start(_app):
        ctx.hub = Hub()
        ctx.stop = threading.Event()
        ctx.thread = threading.Thread(target=capture_loop, daemon=True, args=(
            ctx.stop, source, detector, modules, ctx.hub, asyncio.get_running_loop(), cfg.get("show_video", True)))
        ctx.thread.start()

    async def cleanup(_app):
        ctx.stop.set()
        ctx.thread.join(timeout=2)
        source.close()

    app.on_startup.append(start)
    app.on_cleanup.append(cleanup)
    return app


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    for noisy in ("faster_whisper", "httpx", "huggingface_hub"):      # 語音辨識每一句都會印，太吵
        logging.getLogger(noisy).setLevel(logging.WARNING)
    cfg = config.load(argv)

    source, notice = open_source(cfg)
    if source.kind == "demo":
        detector = DemoPose()
    else:
        try:
            detector = YoloPose(cfg["model"], conf=cfg["conf"], max_people=cfg["max_people"], device=cfg["device"])
        except Exception as e:
            source.close()
            raise SystemExit(f"載入模型失敗：{e}\n模型檔：{cfg['model']}")
    try:
        card_list = load_cards()
    except (OSError, ValueError) as e:
        source.close()
        raise SystemExit(f"讀不到圖卡清單 cards.json：{e}")
    demo = source.kind == "demo"
    modules = {"cards": DemoCards(card_list) if demo else CardDetector(card_list)}
    if cfg.get("objects_model") and not demo:
        try:
            yolo = YoloObjects(cfg["objects_model"], card_list, conf=cfg["objects_conf"], device=cfg["device"])
            modules["cards"] = CombinedCards(modules["cards"], yolo)
            if yolo.missing:
                notice = (notice + "；" if notice else "") + f"模型的類別在 cards.json 找不到（要加 en）：{'、'.join(yolo.missing)}"
        except Exception as e:
            notice = (notice + "；" if notice else "") + f"自訂物件模型載入失敗：{e}"
    if cfg["hands"]:
        try:
            modules["hands"] = hands.DemoHands() if demo else hands.HandDetector(max_hands=cfg["max_hands"])
        except hands.HandsUnavailable as e:
            notice = (notice + "；" if notice else "") + f"手部辨識關閉：{e}"
    asr_engine = None
    if cfg.get("asr"):
        try:
            asr_engine = asr.WhisperASR(cfg["asr_model"], cfg["asr_device"])
        except asr.AsrUnavailable as e:
            notice = (notice + "；" if notice else "") + f"語音辨識關閉：{e}"
    try:
        robot = make_robot(cfg)
    except Exception as e:
        log.warning("接不上平台的機器人（%s），改用模擬機器人", e)
        robot = MockRobot()
        notice = (notice + "；" if notice else "") + f"接不上平台的機器人，改用模擬：{e}"

    if notice:
        log.warning(notice)
    log.info("影像：%s｜辨識：%s｜機器人：%s", source.label,
             "、".join([detector.label] + [m.label for m in modules.values()]), robot.label)
    if not cfg["show_video"]:
        log.info("隱私模式：網頁只看得到骨架和圖卡框，不送出影像")
    url = f"http://{'127.0.0.1' if cfg['host'] in ('0.0.0.0', '127.0.0.1') else cfg['host']}:{cfg['port']}"
    print(f"\n  打開瀏覽器：{url}\n  要停止請按 Ctrl+C（或 VS Code 的紅色方塊）\n", flush=True)
    web.run_app(build_app(cfg, source, detector, robot, notice, modules, card_list, asr_engine),
                host=cfg["host"], port=cfg["port"],
                print=None, access_log=None)
    return 0
