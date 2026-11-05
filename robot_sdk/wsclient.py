"""最小的同步 WebSocket client（只用標準函式庫）：給邊緣端的轉接程式用。

check_accept=False 可以接上握手碼算錯的舊伺服器（ZenboControl 10.21～11.30 的 WsHub 把 RFC 6455
的 GUID 打錯一段，標準函式庫都會拒絕連線）。
"""
import base64
import hashlib
import json
import os
import socket
import struct
import threading
from urllib.parse import urlparse

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WSClosed(Exception):
    pass


class WS:
    def __init__(self, url, timeout=10, check_accept=True):
        u = urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        path = (u.path or "/") + (("?" + u.query) if u.query else "")
        req = ("GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n") % (path, u.hostname, u.port or 80, key)
        self.sock.sendall(req.encode("ascii"))
        head = b""
        while b"\r\n\r\n" not in head:
            c = self.sock.recv(1)
            if not c:
                raise WSClosed("handshake failed")
            head += c
        lines = head.decode("latin1").split("\r\n")
        if " 101 " not in lines[0]:
            raise WSClosed("handshake refused: " + lines[0])
        if check_accept:
            want = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
            got = [ln.split(":", 1)[1].strip() for ln in lines if ln.lower().startswith("sec-websocket-accept:")]
            if got != [want]:
                raise WSClosed("bad Sec-WebSocket-Accept")
        self.sock.settimeout(None)
        self.lock = threading.Lock()
        self.closed = False

    def _frame(self, opcode, payload):
        if self.closed:
            raise WSClosed("closed")
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        n = len(payload)
        if n < 126:
            head = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n <= 0xFFFF:
            head = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            head = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        with self.lock:
            self.sock.sendall(head + mask + masked)

    def send_text(self, text):
        self._frame(0x1, text.encode("utf-8"))

    def send_json(self, obj):
        self.send_text(json.dumps(obj, ensure_ascii=False))

    def _exact(self, n):
        buf = b""
        while len(buf) < n:
            c = self.sock.recv(n - len(buf))
            if not c:
                raise WSClosed("connection closed")
            buf += c
        return buf

    def recv_json(self):
        while True:
            b1, b2 = struct.unpack("!BB", self._exact(2))
            op, n = b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._exact(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._exact(8))[0]
            mask = self._exact(4) if b2 & 0x80 else None
            data = self._exact(n) if n else b""
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if op == 0x8:
                raise WSClosed("closed by peer")
            if op == 0x9:
                self._frame(0xA, data)
                continue
            if op == 0x1:
                try:
                    return json.loads(data.decode("utf-8"))
                except ValueError:
                    continue

    def close(self):
        if self.closed:
            return
        try:
            self._frame(0x8, b"")
        except Exception:
            pass
        self.closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()
