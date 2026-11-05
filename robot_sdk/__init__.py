"""Robot SDK（Phase 5）：讓 Brain 不用自己處理 HTTP、JSON 和 WebSocket。

平台版用法（一個邊緣 Gateway 管多台）：

    from robot_sdk import Platform

    platform = Platform("http://edge-pc:8080", token="…")
    print(platform.robots())                # 哪些機器人在線
    robot = platform.robot("zenbo-02")
    with robot.lease(ttl=10):               # 取得控制權；heartbeat 會自動續約
        robot.move(0.5)
    platform.emergency_stop_all()           # 全部急停

單機版用法（舊程式只要把位址換成邊緣電腦、補上 robot_id 和 token）：

    from robot_sdk import Robot

    robot = Robot("192.168.50.35", robot_id="zenbo-01", token="…")
    robot.move(0.5)                         # 前進 0.5 公尺，等它走完才返回
    robot.rotate(90)                        # 左轉 90 度
    robot.speak("你好")
    robot.on("person.detected", lambda e: print("有人來了", e["data"]))
    robot.listen()                          # 開始收事件（背景執行緒）

設計重點（沿用 zenbo/downloads/robot_sdk.py）：
  · 只用 Python 標準函式庫。現場電腦常常不能隨便裝套件，WebSocket 也自己實作。
  · 預設 wait=True，等到 completed 才返回；要並行（邊走邊說）就傳 wait=False。
  · 被 Gateway 拒絕一律丟 RobotCommandRejected，例外裡帶錯誤代碼。
  · 背景自動送 heartbeat，對應 Gateway 的斷線保護；heartbeat 也會續約控制權。
"""
import base64
import contextlib
import json
import os
import socket
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

PROTOCOL = "RBP"
VERSION = "1.0"

__all__ = ["Platform", "Robot", "RobotError", "RobotCommandRejected", "RobotCommandFailed"]


class RobotError(Exception):
    """SDK 的共同基底，方便呼叫端一次攔下來。"""


class RobotCommandRejected(RobotError):
    def __init__(self, code, message, reply=None):
        super().__init__("%s: %s" % (code, message))
        self.code = code
        self.message = message
        self.reply = reply          # 做不到的技能：機器人要唸的固定句子


class RobotCommandFailed(RobotError):
    def __init__(self, code, message):
        super().__init__("%s: %s" % (code, message))
        self.code = code
        self.message = message


def _split_url(host, port):
    if "://" in host:
        u = urllib.parse.urlparse(host)
        return u.hostname, u.port or 80
    return host, port


class Robot:

    def __init__(self, host, port=8080, robot_id="zenbo-01", token=""):
        self.host, self.port = _split_url(host, port)
        self.robot_id = robot_id
        self.token = token
        self.gateway = "http://%s:%d" % (self.host, self.port)
        self._handlers = {}
        self._results = {}
        self._results_lock = threading.Condition()
        self._ws = None
        self._ws_ready = False
        self._listening = False
        self.heartbeat_paused = False       # 測試用：模擬 client 當掉、不再送 heartbeat
        self.last_response = None

    # ------------------------------------------------------------------ 命令

    def move(self, distance_m, speed=None, wait=True, timeout=60):
        """前進（負值後退），單位公尺。"""
        params = {"distance": distance_m}
        if speed is not None:
            params["speed"] = speed
        return self._command("motion.move", params, wait, timeout)

    def rotate(self, angle_deg, wait=True, timeout=60):
        """原地旋轉，正值逆時針（左轉），單位度。"""
        return self._command("motion.rotate", {"angle": angle_deg}, wait, timeout)

    def drive(self, linear=0.0, angular=0.0, duration=1.0, wait=True):
        """連續行駛：linear 公尺/秒、angular 度/秒（正值左轉），走 duration 秒後自動停。"""
        return self._command("motion.drive",
                             {"linear": linear, "angular": angular, "duration": duration},
                             wait, duration + 10)

    def stop(self):
        return self._command("motion.stop", {}, wait=False)

    def move_head(self, yaw=None, pitch=None, wait=True, timeout=30):
        params = {}
        if yaw is not None:
            params["yaw"] = yaw
        if pitch is not None:
            params["pitch"] = pitch
        return self._command("head.move", params, wait, timeout)

    def center_head(self, wait=True):
        return self._command("head.center", {}, wait, 15)

    def speak(self, text, wait=True, timeout=60):
        return self._command("speech.speak", {"text": text}, wait, timeout)

    def stop_speaking(self):
        return self._command("speech.stop", {}, wait=False)

    def hear(self, timeout=15):
        """聽一句話，回傳辨識出的文字。"""
        event = self._command("speech.listen", {"timeout": timeout}, True, timeout + 30)
        return (event.get("data") or {}).get("text", "")

    def set_volume(self, level, wait=True):
        return self._command("speech.volume", {"level": level}, wait, 10)

    def set_expression(self, expression, wait=True, timeout=15):
        """表情：可用值見 capabilities()["actions"]["display.expression"]"""
        return self._command("display.expression", {"expression": expression}, wait, timeout)

    def show_text(self, text, wait=True):
        return self._command("display.text", {"text": text}, wait, 15)

    def clear_text(self, wait=True):
        return self._command("display.clear", {}, wait, 15)

    def display_config(self, **switches):
        """螢幕顯示開關：subtitles、camera_preview、face_boxes、names_on_screen"""
        return self._command("display.config", switches, True, 15)

    def privacy(self, on=True):
        """隱私模式：關掉鏡頭畫面、畫框、名字、人臉辨識；字幕不受影響。不需要控制權"""
        return self._command("system.privacy", {"on": on}, wait=False)

    def play_action(self, name, wait=True, timeout=60):
        return self._command("action.play", {"name": name}, wait, timeout)

    def stop_action(self):
        return self._command("action.stop", {}, wait=False)

    def run_skill(self, name, wait=True, timeout=120, **kwargs):
        params = {"name": name}
        params.update(kwargs)
        return self._command("skill.run", params, wait, timeout)

    def stop_skill(self):
        return self._command("skill.stop", {}, wait=False)

    def take_photo(self):
        event = self._command("vision.photo", {}, True, 20)
        return (event.get("data") or {}).get("file", "")

    def follow(self, mode="head"):
        """看著人：off、head（只轉頭）、body（轉頭加轉身）。"""
        return self._command("vision.follow", {"mode": mode}, True, 15)

    def dock(self):
        return self._command("power.dock", {}, True, 20)

    def call_sdk(self, method, *args, wait=True, timeout=30):
        """呼叫機器人 SDK 的任何方法（要先在管理台「SDK 管理」開啟）。method 例如 "WheelLights.turnOff(enum:WheelLights$Lights,int)"。"""
        return self._command("sdk.call", {"method": method, "args": list(args), "timeout_s": timeout}, wait, timeout + 10)

    def emergency_stop(self):
        return self._command("system.emergency_stop", {}, wait=False)

    def resume(self):
        return self._command("system.resume", {}, wait=False)

    # ------------------------------------------------------------------ 查詢

    def status(self):
        return self._get("/status?robot_id=" + urllib.parse.quote(self.robot_id))

    def state(self):
        """電量、在不在動…"""
        return self.status().get("robot", {})

    def capabilities(self):
        return self._get("/capabilities?robot_id=" + urllib.parse.quote(self.robot_id))

    def skills(self):
        """這台能用的技能（含啟用、允許 AI 開關）"""
        return self._get("/skills?robot_id=" + urllib.parse.quote(self.robot_id))

    def robots(self):
        return self._get("/robots")

    # ------------------------------------------------------------------ 控制權

    def acquire_lease(self, ttl=10):
        """取得控制權。別人（同級或更高優先）持有時丟 RobotCommandRejected(LEASE_HELD)。
        WS /events 的 heartbeat 會自動續約，所以這裡會順便開始收事件。"""
        self.listen()
        self._wait_connected()
        r = self._request("POST", "/lease", {"robot_id": self.robot_id, "ttl": ttl})
        if "error" in r:
            raise RobotCommandRejected(r["error"].get("code", "UNKNOWN"), r["error"].get("message", ""))
        return r["lease"]

    def release_lease(self):
        return self._request("DELETE", "/lease?robot_id=" + urllib.parse.quote(self.robot_id))

    @contextlib.contextmanager
    def lease(self, ttl=10):
        self.acquire_lease(ttl)
        try:
            yield self
        finally:
            try:
                self.release_lease()
            except RobotError:
                pass

    # ------------------------------------------------------------------ 事件

    def on(self, event_type, handler):
        """註冊事件處理函式。event_type 例如 "person.detected"，"*" 表示全收。"""
        self._handlers.setdefault(event_type, []).append(handler)

    def listen(self, block=False):
        """連上 WS /events 開始收事件，並自動送 heartbeat。"""
        if self._listening:
            return
        self._listening = True
        t = threading.Thread(target=self._event_loop, daemon=True)
        t.start()
        if block:
            t.join()

    def close(self):
        self._listening = False
        ws = self._ws
        if ws:
            try:
                ws.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                ws.close()
            except OSError:
                pass

    # ------------------------------------------------------------------ 內部

    def _command(self, action, params, wait=True, timeout=60):
        request_id = str(uuid.uuid4())
        body = {
            "protocol": PROTOCOL,
            "version": VERSION,
            "request_id": request_id,
            "robot_id": self.robot_id,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "action": action,
            "parameters": params,
        }
        if (wait or action.startswith("motion.")) and not self._listening:
            # 先接好事件連線再送命令：很快做完的命令，完成事件會比連線早送出，晚接就收不到。
            # 移動命令也要先有 heartbeat：Gateway 的斷線保護要求送移動命令的 client 正在送 heartbeat
            self.listen()
        if wait or action.startswith("motion."):
            self._wait_connected()
        result = self._request("POST", "/" + action.replace(".", "/"), body)
        self.last_response = result
        if result.get("status") == "rejected":
            err = result.get("error", {})
            raise RobotCommandRejected(err.get("code", "UNKNOWN"), err.get("message", ""), err.get("reply"))
        if not wait:
            return request_id
        if result.get("results"):
            return [self._wait_for_result(r["request_id"], timeout)
                    for r in result["results"] if r["status"] == "accepted"]
        return self._wait_for_result(request_id, timeout)

    def _wait_connected(self, timeout=3):
        end = time.time() + timeout
        while not self._ws_ready and time.time() < end:
            time.sleep(0.02)

    def _wait_for_result(self, request_id, timeout):
        """等 WS 上同一個 request_id 的 completed／failed／cancelled。"""
        if not self._listening:
            self.listen()
        deadline = time.time() + timeout
        event = None
        while event is None:
            with self._results_lock:
                if request_id in self._results:
                    event = self._results.pop(request_id)
                    break
                left = deadline - time.time()
                if left <= 0:
                    raise RobotCommandFailed("TIMEOUT", "no result for %s in %ds" % (request_id, timeout))
                self._results_lock.wait(min(left, 1.0))
            if event is None and request_id not in self._results and not self._ws_ready:
                # 保險：WS 斷線時從最近事件補查
                event = self._recent_result(request_id)
        etype = event.get("type", "")
        if etype.endswith(".failed"):
            err = (event.get("data") or {}).get("error", {})
            raise RobotCommandFailed(err.get("code", "ADAPTER_ERROR"), err.get("message", ""))
        if etype.endswith(".cancelled"):
            raise RobotCommandFailed("CANCELLED", (event.get("data") or {}).get("reason", "cancelled"))
        return event

    def _recent_result(self, request_id):
        try:
            path = "/events/recent?robot_id=" + urllib.parse.quote(self.robot_id)
            for e in reversed(self._get(path).get("events", [])):
                if e.get("request_id") == request_id and \
                        e.get("type", "").endswith((".completed", ".failed", ".cancelled")):
                    return e
        except (OSError, RobotError, ValueError):
            pass
        return None

    def _headers(self):
        h = {"Content-Type": "application/json; charset=utf-8"}
        if self.token:
            h["Authorization"] = "Bearer " + self.token
        return h

    def _request(self, method, path, body=None):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.gateway + path, data=data, headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode("utf-8") or "{}")
        except urllib.error.URLError as e:
            raise RobotError("連不上 Gateway %s：%s" % (self.gateway, e.reason))

    def _get(self, path):
        r = self._request("GET", path)
        if "error" in r and isinstance(r["error"], dict) and "code" in r["error"]:
            raise RobotCommandRejected(r["error"]["code"], r["error"].get("message", ""))
        return r

    # ---- WebSocket（只實作 Client 需要的部分，不裝第三方套件）----

    def _event_loop(self):
        while self._listening:
            try:
                self._ws = self._ws_connect()
                self._ws_ready = True
                threading.Thread(target=self._heartbeat_loop, args=(self._ws,), daemon=True).start()
                while self._listening:
                    msg = self._ws_recv(self._ws)
                    if msg is None:
                        break
                    self._dispatch(msg)
            except (OSError, RobotError, struct.error, TypeError):
                pass
            finally:
                self._ws_ready = False
                if self._ws:
                    try:
                        self._ws.close()
                    except OSError:
                        pass
                    self._ws = None
            if self._listening:
                time.sleep(2)          # 斷線後重連，現場 Wi-Fi 難免斷一下

    def _ws_connect(self):
        s = socket.create_connection((self.host, self.port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        query = urllib.parse.urlencode({"robot_id": self.robot_id if not self.robot_id.startswith(("group:", "*")) else "",
                                        "token": self.token})
        req = ("GET /events?%s HTTP/1.1\r\n"
               "Host: %s:%d\r\n"
               "Upgrade: websocket\r\n"
               "Connection: Upgrade\r\n"
               "Sec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n") % (query, self.host, self.port, key)
        s.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = s.recv(1)
            if not chunk:
                raise RobotError("WebSocket 握手失敗")
            head += chunk
        if b"101" not in head.split(b"\r\n")[0]:
            raise RobotError("WebSocket 握手被拒：" + head.split(b"\r\n")[0].decode("latin1"))
        s.settimeout(None)
        return s

    def _heartbeat_loop(self, ws):
        """Gateway 的斷線保護靠這個：停了它，Gateway 就會自動把機器人停下來。"""
        while self._listening and self._ws is ws:
            if not self.heartbeat_paused:
                try:
                    self._ws_send(ws, '{"type":"heartbeat"}')
                except OSError:
                    return
            time.sleep(0.5)

    @staticmethod
    def _ws_send(sock, text):
        payload = text.encode("utf-8")
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        header = bytearray([0x81])
        if len(payload) < 126:
            header.append(0x80 | len(payload))
        elif len(payload) <= 0xFFFF:
            header.append(0x80 | 126)
            header += struct.pack(">H", len(payload))
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", len(payload))
        sock.sendall(bytes(header) + mask + masked)

    @staticmethod
    def _recv_exact(sock, n):
        buf = b""
        while len(buf) < n:
            chunk = sock.recv(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    def _ws_recv(self, sock):
        head = self._recv_exact(sock, 2)
        if not head:
            return None
        opcode = head[0] & 0x0F
        masked = bool(head[1] & 0x80)
        length = head[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._recv_exact(sock, 2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv_exact(sock, 8))[0]
        mask = self._recv_exact(sock, 4) if masked else None
        payload = self._recv_exact(sock, length) if length else b""
        if payload is None:
            return None
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        if opcode == 0x8:
            return None
        if opcode != 0x1:
            return {}
        try:
            return json.loads(payload.decode("utf-8"))
        except ValueError:
            return {}

    def _dispatch(self, event):
        if not event:
            return
        etype = event.get("type", "")
        request_id = event.get("request_id")
        if request_id and etype.endswith((".completed", ".failed", ".cancelled")):
            with self._results_lock:
                self._results[request_id] = event
                self._results_lock.notify_all()
        for key in (etype, "*"):
            for handler in self._handlers.get(key, []):
                try:
                    handler(event)
                except Exception as e:                      # noqa: BLE001
                    print("事件處理函式出錯：", e)


class Platform:
    """一個邊緣 Gateway，管多台機器人。不知道位址時用 Platform.discover(token=…)"""

    @classmethod
    def discover(cls, token="", timeout=3.0, site_id=None, port=47110):
        """在區網廣播找 Gateway（UDP 47110），找到就回傳 Platform；找不到丟 RobotError"""
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.settimeout(0.5)
        msg = {"type": "rbp.discover", "v": 1}
        if site_id:
            msg["site_id"] = site_id
        end = time.time() + timeout
        try:
            while time.time() < end:
                for target in ("255.255.255.255", "127.0.0.1"):
                    try:
                        s.sendto(json.dumps(msg).encode("utf-8"), (target, port))
                    except OSError:
                        pass
                try:
                    raw, _ = s.recvfrom(4096)
                    r = json.loads(raw.decode("utf-8"))
                    if r.get("type") == "rbp.gateway":
                        return cls(r["api_url"], token)
                except (socket.timeout, ValueError):
                    continue
        finally:
            s.close()
        raise RobotError("區網裡找不到 Gateway（UDP %d 沒有回覆）" % port)

    def __init__(self, url, token=""):
        self.host, self.port = _split_url(url if "://" in url else "http://" + url, 80)
        self.token = token
        self._robots = {}
        self._query = Robot(self.host, self.port, robot_id="", token=token)

    def robot(self, robot_id):
        if robot_id not in self._robots:
            self._robots[robot_id] = Robot(self.host, self.port, robot_id=robot_id, token=self.token)
        return self._robots[robot_id]

    def group(self, name):
        """群組命令：Gateway 拆成每台各一個命令，每台各自檢查、各自回 request_id"""
        key = "group:" + name
        if key not in self._robots:
            self._robots[key] = Robot(self.host, self.port, robot_id=key, token=self.token)
        return self._robots[key]

    def robots(self):
        return self._query._get("/robots").get("robots", [])

    def site(self):
        return self._query._get("/site")

    def emergency_stop_all(self):
        """全部急停（robot_id = "*"）。不需要控制權。回傳 Gateway 的 Response（含每台結果）"""
        r = Robot(self.host, self.port, robot_id="*", token=self.token)
        r._command("system.emergency_stop", {}, wait=False)
        return r.last_response

    def close(self):
        for r in self._robots.values():
            r.close()
