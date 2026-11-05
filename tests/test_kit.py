"""測試：python -m unittest discover -s tests -v（VS Code：Tasks →「3. 跑測試」）。不需要攝影機。"""
import json
import math
import sys
import time
import unittest
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pose_service import robot as robot_mod                     # noqa: E402
from pose_service import hands as hands_mod                     # noqa: E402
from pose_service.cards import CardDetector, DemoCards, load_cards, marker_png  # noqa: E402

try:
    import mediapipe  # noqa: F401
    HAS_MEDIAPIPE = True
except ImportError:
    HAS_MEDIAPIPE = False
from pose_service.detector import DemoPose, YoloPose             # noqa: E402
from pose_service.server import build_app                        # noqa: E402
from pose_service.sources import DemoSource, read_image          # noqa: E402

HERE = Path(__file__).resolve().parent


class YoloTest(unittest.TestCase):
    def test_bus_matches_ultralytics(self):
        """bus.jpg 的結果要跟官方 ultralytics 套件一樣（bus_expected.json 是用官方套件跑出來的）"""
        det = YoloPose(ROOT / "models" / "yolo11n-pose.onnx")
        img = read_image(HERE / "bus.jpg")
        h, w = img.shape[:2]
        expected = json.loads((HERE / "bus_expected.json").read_text())
        people = det.detect(img)
        json.dumps(people)                      # 要能直接轉成 JSON（numpy 的 float32 不行；曾經因此整個停擺）
        self.assertEqual(len(people), len(expected))
        for p in people:
            box = [p["box"][0] * w, p["box"][1] * h, p["box"][2] * w, p["box"][3] * h]
            ref = min(expected, key=lambda r: abs(r["box"][0] - box[0]))
            for a, b in zip(box, ref["box"]):
                self.assertAlmostEqual(a, b, delta=2.0)
            for k, r in zip(p["kp"], ref["kp"]):
                if r[2] > 0.5:
                    self.assertAlmostEqual(k[0] * w, r[0], delta=2.0)
                    self.assertAlmostEqual(k[1] * h, r[1], delta=2.0)
        areas = [(p["box"][2] - p["box"][0]) * (p["box"][3] - p["box"][1]) for p in people]
        self.assertEqual(areas, sorted(areas, reverse=True), "people[0] 要是最大的人")


class DemoTest(unittest.TestCase):
    def test_demo_raises_left_hand(self):
        demo = DemoPose()
        demo.t0 = time.time() - 4.5           # 第 3～6 秒是舉左手，第 4.5 秒舉到最高
        p = demo.detect(None)[0]
        self.assertEqual(len(p["kp"]), 17)
        left_wrist, left_shoulder = p["kp"][9], p["kp"][5]
        right_wrist, right_shoulder = p["kp"][10], p["kp"][6]
        self.assertLess(left_wrist[1], left_shoulder[1] - 0.05)
        self.assertGreater(right_wrist[1], right_shoulder[1])


class CardTest(unittest.TestCase):
    def photo_of(self, card_id, at=(320, 200), size=120, tilt=0.25):
        """做一張「拍到圖卡」的假照片：標記貼在灰色背景上，有點斜、有透視"""
        marker = cv2.imdecode(np.frombuffer(marker_png(card_id, 200), np.uint8), cv2.IMREAD_GRAYSCALE)
        m = marker.shape[0]
        src = np.float32([[0, 0], [m, 0], [m, m], [0, m]])
        x, y, s = at[0], at[1], size / 2
        dst = np.float32([[x - s, y - s * (1 - tilt)], [x + s, y - s], [x + s * (1 - tilt), y + s], [x - s, y + s]])
        frame = cv2.warpPerspective(marker, cv2.getPerspectiveTransform(src, dst), (640, 480),
                                    borderMode=cv2.BORDER_CONSTANT, borderValue=150)
        return cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)

    def test_recognises_tilted_card(self):
        cards = load_cards()
        det = CardDetector(cards)
        found = det.detect(self.photo_of(2))
        self.assertEqual([c["id"] for c in found], [2])
        self.assertEqual(found[0]["name"], cards[2]["name"])
        self.assertAlmostEqual(found[0]["center"][0], 0.5, delta=0.03)
        self.assertEqual(len(found[0]["corners"]), 4)

    def test_ignores_unknown_marker(self):
        ids = {c["id"] for c in load_cards()}
        unknown = next(i for i in range(50) if i not in ids)
        self.assertEqual(CardDetector(load_cards()).detect(self.photo_of(unknown)), [])

    def test_nearest_card_first(self):
        det = CardDetector(load_cards())
        frame = self.photo_of(3, at=(160, 240), size=90)
        frame = np.minimum(frame, self.photo_of(5, at=(470, 240), size=160))   # 兩張卡在同一張照片
        found = det.detect(frame)
        self.assertEqual([c["id"] for c in found], [5, 3])

    def test_demo_cards(self):
        demo = DemoCards(load_cards())
        demo.t0 = time.time() - 1.0           # 第一張卡（0～2.4 秒）
        found = demo.detect(None)
        self.assertEqual(found[0]["id"], load_cards()[0]["id"])


class HandsTest(unittest.TestCase):
    def test_classify_shapes(self):
        """用示範手的形狀測手勢判斷（不需要 mediapipe）"""
        cases = {
            (False, False, False, False, False): "rock",
            (False, True, True, False, False): "scissors",
            (True, True, True, True, True): "paper",
            (False, True, False, False, False): "point",
            (True, False, False, False, False): "rock",     # 拇指往旁邊伸不算「讚」
        }
        for shape, want in cases.items():
            kp = [(0.4 + x * 0.1 * 0.75, 0.6 + y * 0.1) for x, y in hands_mod.demo_hand(list(shape))]
            fingers, count, gesture = hands_mod.classify(kp)
            self.assertEqual(gesture, want, shape)
            self.assertEqual(count, sum(shape), shape)

    def test_classify_rotation(self):
        """手轉 90 度（橫著）也要認得：判斷是看距離，不是看上下"""
        kp = [(0.4 - y * 0.1 * 0.75, 0.5 + x * 0.1) for x, y in hands_mod.demo_hand([False, True, True, False, False])]
        self.assertEqual(hands_mod.classify(kp)[2], "scissors")

    def test_thumbs_up(self):
        pts = hands_mod.demo_hand([False] * 5)
        pts[3], pts[4] = [-0.45, -1.2], [-0.5, -1.6]                # 拇指往上翹
        kp = [(0.4 + x * 0.1 * 0.75, 0.6 + y * 0.1) for x, y in pts]
        self.assertEqual(hands_mod.classify(kp)[2], "thumbs_up")

    @unittest.skipUnless(HAS_MEDIAPIPE, "沒有安裝 mediapipe")
    def test_real_photo_matches_yolo_sides(self):
        """真的照片：兩隻手都是張開的；left／right 要跟 YOLO Pose 的手腕一致"""
        img = read_image(HERE / "hands.jpg")
        found = hands_mod.HandDetector().detect(img)
        json.dumps(found)                       # 要能直接轉成 JSON 送給網頁
        self.assertEqual(len(found), 2)
        self.assertEqual({h["gesture"] for h in found}, {"paper"})
        person = YoloPose(ROOT / "models" / "yolo11n-pose.onnx").detect(img)[0]
        for h in found:
            wrist = h["kp"][0]
            nearest = min(("left", 9), ("right", 10), key=lambda s: math.dist(wrist, person["kp"][s[1]][:2]))[0]
            self.assertEqual(h["side"], nearest)

    def test_demo_hands(self):
        demo = hands_mod.DemoHands()
        for t, want in ((1.0, "rock"), (3.5, "scissors"), (6.0, "paper")):
            demo.t0 = time.time() - t
            self.assertEqual(demo.detect(None)[0]["gesture"], want)


class RobotGuardTest(unittest.TestCase):
    def test_rules(self):
        g = robot_mod.RobotGuard(robot_mod.MockRobot())
        self.assertIn("你好", g.run("say", text="你好"))
        with self.assertRaises(robot_mod.RobotRefused):
            g.run("say", text="又一次")            # 太頻繁
        with self.assertRaises(robot_mod.RobotRefused):
            g.run("move", text="")                 # 不在白名單
        with self.assertRaises(robot_mod.RobotRefused):
            g.run("skill")                         # 沒給技能名稱
        g.last.clear()
        with self.assertRaises(robot_mod.RobotRefused):
            g.run("say", text="長" * 101)

    def test_skill_allow_list_and_cooldown(self):
        rules = {"cooldown_s": 0.0, "max_say_length": 10, "skills": ["gesture.wave"]}
        g = robot_mod.RobotGuard(robot_mod.MockRobot(), rules)
        self.assertIn("gesture.wave", g.run("skill", name="gesture.wave"))
        with self.assertRaises(robot_mod.RobotRefused):
            g.run("skill", name="flow.dance")           # 不在清單
        with self.assertRaises(robot_mod.RobotRefused):
            g.run("nod")                                # 清單裡沒有 gesture.nod
        g.run("say", text="一二三")
        g.run("say", text="冷卻 0 秒")                   # cooldown_s 0：馬上可以再叫
        with self.assertRaises(robot_mod.RobotRefused):
            g.run("say", text="超過十個字的一句話啊啊")

    def test_expression_and_show(self):
        rules = {"cooldown_s": 0.0, "max_say_length": 10, "skills": [], "expressions": ["happy"]}
        g = robot_mod.RobotGuard(robot_mod.MockRobot(), rules)
        self.assertIn("happy", g.run("expression", name="happy"))
        with self.assertRaises(robot_mod.RobotRefused):
            g.run("expression", name="angry")           # 不在 expressions 清單
        with self.assertRaises(robot_mod.RobotRefused):
            g.run("expression")                         # 沒給表情名稱
        with self.assertRaises(robot_mod.RobotRefused):
            g.run("skill", name="happy")                # 表情清單不能拿來當技能用
        self.assertIn("加油", g.run("show", text="加油"))
        with self.assertRaises(robot_mod.RobotRefused):
            g.run("show", text="")
        with self.assertRaises(robot_mod.RobotRefused):
            g.run("show", text="超過十個字的一句話啊啊")

    def test_rules_file(self):
        rules = robot_mod.load_rules()
        self.assertIn("gesture.nod", rules["skills"])
        self.assertGreater(rules["cooldown_s"], 0)
        self.assertIn("happy", rules["expressions"])


class ServerTest(unittest.IsolatedAsyncioTestCase):
    async def test_endpoints(self):
        from aiohttp.test_utils import TestClient, TestServer
        cards = load_cards()
        modules = {"cards": DemoCards(cards), "hands": hands_mod.DemoHands()}
        app = build_app({}, DemoSource(), DemoPose(), robot_mod.MockRobot(), modules=modules, card_list=cards)
        async with TestClient(TestServer(app)) as client:
            games = await (await client.get("/api/games")).json()
            ids = [g["id"] for g in games]
            for gid in ("raise-hand", "card-quiz", "bubble-pop", "rps", "seated-exercise", "_template"):
                self.assertIn(gid, ids)
            self.assertTrue(next(g for g in games if g["id"] == "_template")["template"])

            for url in ("/games/raise-hand/index.html", "/games/card-quiz/index.html",
                        "/games/bubble-pop/index.html", "/games/rps/index.html", "/games/seated-exercise/index.html",
                        "/cards/print.html"):
                self.assertEqual((await client.get(url)).status, 200, url)

            self.assertEqual(len(await (await client.get("/api/cards")).json()), len(cards))
            png = await client.get(f"/api/cards/{cards[0]['id']}/marker.png")
            self.assertEqual(png.content_type, "image/png")
            self.assertEqual((await client.get("/api/cards/99/marker.png")).status, 404)

            ws = await client.ws_connect("/ws")
            hello = await ws.receive_json(timeout=5)
            self.assertEqual(hello["type"], "hello")
            self.assertEqual(len(hello["names"]), 17)
            self.assertEqual(set(hello["modules"]), {"cards", "hands"})
            self.assertEqual(len(hello["hand_connections"]), len(hands_mod.CONNECTIONS))
            pose = await ws.receive_json(timeout=5)
            self.assertEqual(pose["type"], "pose")
            self.assertEqual(len(pose["people"][0]["kp"]), 17)
            self.assertIn("cards", pose)
            self.assertIn("hands", pose)

            r = await (await client.post("/api/robot", json={"action": "say", "text": "測試"})).json()
            self.assertTrue(r["ok"])
            for _ in range(20):                    # 機器人事件夾在姿勢訊息中間
                msg = await ws.receive_json(timeout=5)
                if msg["type"] == "robot":
                    break
            self.assertEqual(msg["type"], "robot")
            self.assertIn("測試", msg["result"])

            bad = await (await client.post("/api/robot", json={"action": "move"})).json()
            self.assertFalse(bad["ok"])
            await ws.close()

    async def test_real_models_over_websocket(self):
        """真的 YOLO（和手部，有裝的話）跑在照片上，結果要能從 WebSocket 送出來（不是示範模式）"""
        from aiohttp.test_utils import TestClient, TestServer

        class PhotoSource:
            kind, label = "video", "測試照片"

            def __init__(self, path):
                self.frame = read_image(path)

            def read(self):
                time.sleep(0.03)
                return self.frame.copy()

            def close(self):
                pass

        modules = {"cards": CardDetector(load_cards())}
        if HAS_MEDIAPIPE:
            modules["hands"] = hands_mod.HandDetector()
        app = build_app({}, PhotoSource(HERE / "bus.jpg"), YoloPose(ROOT / "models" / "yolo11n-pose.onnx"),
                        robot_mod.MockRobot(), modules=modules)
        async with TestClient(TestServer(app)) as client:
            ws = await client.ws_connect("/ws")
            self.assertEqual((await ws.receive_json(timeout=5))["type"], "hello")
            pose = await ws.receive_json(timeout=10)
            self.assertEqual(len(pose["people"]), 3)
            await ws.close()

    async def test_privacy_mode(self):
        """show_video: false：影像串流直接拒絕，但骨架照樣送"""
        from aiohttp.test_utils import TestClient, TestServer
        app = build_app({"show_video": False}, DemoSource(), DemoPose(), robot_mod.MockRobot())
        async with TestClient(TestServer(app)) as client:
            self.assertEqual((await client.get("/video.mjpg")).status, 403)
            status = await (await client.get("/api/status")).json()
            self.assertFalse(status["show_video"])
            ws = await client.ws_connect("/ws")
            hello = await ws.receive_json(timeout=5)
            self.assertFalse(hello["show_video"])
            pose = await ws.receive_json(timeout=5)
            self.assertEqual(len(pose["people"]), 1)
            await ws.close()


if __name__ == "__main__":
    unittest.main()
