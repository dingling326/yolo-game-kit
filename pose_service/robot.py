"""機器人。遊戲只能用下面五個動作，其他一律拒絕：
  say         說一句話（text，長度上限見 robot_actions.json）
  nod         點頭（＝技能 gesture.nod）
  skill       執行平台的技能（name，例如 gesture.wave）。只能用 robot_actions.json 的 skills 清單裡的
  expression  換臉上的表情（name，例如 happy）。只能用 robot_actions.json 的 expressions 清單裡的
  show        在機器人的螢幕上顯示大字（text，長度上限同 say）。給重聽的長輩看

robot_actions.json：允許的技能、表情、說話長度、冷卻時間。改這個檔案就能調整，不用改程式（改完重開伺服器）。

MockRobot：不需要真機，動作只顯示在網頁上（上課預設）。
PlatformRobot：經過 RobotPlatform 的 Gateway。token 只放在這台電腦（環境變數 ROBOT_TOKEN），不會送到網頁。
  Gateway 會再檢查：這台機器人有沒有這個能力、場域有沒有開放、有沒有人在用控制權、是不是急停中。
"""
import json
import time

from .config import ROOT

ACTIONS = ("say", "nod", "skill", "expression", "show")
RULES_FILE = ROOT / "robot_actions.json"
DEFAULT_RULES = {
    "cooldown_s": 0.8,        # 同一個動作至少隔這麼久，避免遊戲每一格畫面都叫機器人；接真機建議 3 秒
    "max_say_length": 100,
    "skills": ["gesture.nod"],
    "expressions": [],
}


def load_rules(path=RULES_FILE):
    rules = dict(DEFAULT_RULES)
    if path.exists():
        with open(path, encoding="utf-8") as f:
            rules.update(json.load(f))
    rules["skills"] = [str(s) for s in rules["skills"]]
    rules["expressions"] = [str(s) for s in rules["expressions"]]
    return rules


class RobotRefused(Exception):
    pass


class MockRobot:
    mode = "mock"
    label = "模擬機器人（不會真的動）"

    def run(self, action, text="", name=""):
        if action == "say":
            return f"說：「{text}」"
        if action == "nod":
            return "點頭"
        if action == "expression":
            return f"表情：{name}"
        if action == "show":
            return f"螢幕顯示：「{text}」"
        return f"執行技能 {name}"


class PlatformRobot:
    mode = "platform"

    def __init__(self, gateway, robot_id, token):
        from robot_sdk import Robot
        if not token:
            raise RuntimeError("要接平台，請先設定環境變數 ROBOT_TOKEN（向老師拿 token）")
        self.robot = Robot(gateway, robot_id=robot_id, token=token)
        self.label = f"{robot_id}（經過 Gateway {gateway}）"

    def run(self, action, text="", name=""):
        from robot_sdk import RobotError
        try:
            if action == "say":
                self.robot.speak(text, wait=False)
                return f"說：「{text}」"
            if action == "nod":
                self.robot.run_skill("gesture.nod", wait=False)
                return "點頭"
            if action == "expression":
                self.robot.set_expression(name, wait=False)
                return f"表情：{name}"
            if action == "show":
                self.robot.show_text(text, wait=False)
                return f"螢幕顯示：「{text}」"
            self.robot.run_skill(name, wait=False)
            return f"執行技能 {name}"
        except RobotError as e:
            raise RobotRefused(f"Gateway 拒絕：{e}") from e
        except OSError as e:
            raise RobotRefused(f"連不到 Gateway：{e}") from e


class RobotGuard:
    """遊戲和機器人中間的檢查：動作白名單、技能白名單、文字長度、太頻繁就擋"""

    def __init__(self, robot, rules=None):
        self.robot = robot
        self.rules = rules or load_rules()
        self.last = {}

    def run(self, action, text="", name=""):
        if action not in ACTIONS:
            raise RobotRefused(f"不支援的動作 {action!r}，只能用 {', '.join(ACTIONS)}")
        text = str(text or "").strip()
        limit = self.rules["max_say_length"]
        if action in ("say", "show") and not (0 < len(text) <= limit):
            raise RobotRefused(f"{action} 的文字要 1～{limit} 字")
        if action in ("skill", "expression") and not name:
            raise RobotRefused(f"{action} 要給名稱 name")
        if action == "expression":
            if name not in self.rules["expressions"]:
                raise RobotRefused(f"表情 {name} 不在 robot_actions.json 的 expressions 清單裡")
        elif action in ("nod", "skill"):
            skill = "gesture.nod" if action == "nod" else name
            if skill not in self.rules["skills"]:
                raise RobotRefused(f"技能 {skill} 不在 robot_actions.json 的允許清單裡")
        now = time.monotonic()
        if now - self.last.get(action, -1e9) < self.rules["cooldown_s"]:
            raise RobotRefused("太頻繁了，等一下再叫機器人")
        self.last[action] = now
        return self.robot.run(action, text=text, name=name)


def make_robot(cfg):
    r = cfg["robot"]
    if r["mode"] == "platform":
        return PlatformRobot(r["gateway"], r["robot_id"], r.get("token", ""))
    return MockRobot()
