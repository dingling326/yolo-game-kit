// 跟 Zenbo 做體操（長照版）：坐著做的上肢體操。
//
// 和「舉手挑戰」不一樣的地方（給長輩用要注意的事）：
//   · 坐著做：只看肩膀、手肘、手腕，下半身被桌子、毯子擋住也沒關係
//   · 先暖身「校正」：量這個人的手能舉多高，目標＝他自己最高的 7～9 成（每個人不一樣）
//   · 某一隻手幾乎舉不起來（例如中風）：那一側的動作自動略過，雙手的動作只看另一隻手
//   · 不計時、不扣分、沒有「失敗」；很久做不到，機器人只會溫和地鼓勵，照服員可以按「跳過」
//   · pickPlayer 只看畫面中間的人，站在旁邊的照服員不會被當成玩家
//   · 機器人說話排隊、每句隔 3 秒以上，接真機（cooldown 3 秒）也不會被擋
import { connect, createStage, point, distance, armLift, pickPlayer, Hold, Reach, robot } from '/common/pose.js';
import { mountTopbar, mountRobot } from '/common/ui.js';

const CALIBRATE_MS = 8000;   // 暖身量角度的時間（機器人說明也在這段時間裡）
const REST_MS = 6000;        // 兩個動作之間休息
const NUDGE_MS = 25000;      // 這麼久沒做到一下，就鼓勵一次
const SAY_GAP_MS = 3200;     // 機器人兩句話至少隔這麼久
const UNABLE_DEG = 35;       // 暖身時這隻手最高不到這個角度：當作這隻手不方便，不出那一側的動作

const lift = (p, side) => armLift(p, side) ?? 0;
const shoulderWidth = (p) => {
  const l = point(p, 'left_shoulder'), r = point(p, 'right_shoulder');
  return l && r ? Math.abs(l.x - r.x) : null;
};
const sideOk = (p, side, t) => t[side] === null || lift(p, side) >= t[side];
const deg = (v) => (v === null ? '—' : `${Math.round(v)}°`);

// needs：要用到哪隻手。any＝至少一隻手能做；both＝兩隻手都要能做
const MOVES = [
  {
    name: '雙手舉高', needs: 'any', reps: 5, holdMs: 800, joints: ['left_wrist', 'right_wrist'],
    say: '我們先把兩隻手一起慢慢舉高，再放下來，做五下。', show: '雙手舉高 🙌',
    check: (p, t) => sideOk(p, 'left', t) && sideOk(p, 'right', t),
    meter: (p, t) => `左手 ${deg(lift(p, 'left'))}／${deg(t.left)}　右手 ${deg(lift(p, 'right'))}／${deg(t.right)}`,
  },
  {
    name: '舉左手', needs: 'left', reps: 3, holdMs: 800, joints: ['left_wrist'],
    say: '換左手，慢慢舉高，再放下來，做三下。', show: '舉左手 ✋',
    check: (p, t) => lift(p, 'left') >= t.left,
    meter: (p, t) => `左手 ${deg(lift(p, 'left'))}／目標 ${deg(t.left)}`,
  },
  {
    name: '舉右手', needs: 'right', reps: 3, holdMs: 800, joints: ['right_wrist'],
    say: '換右手，慢慢舉高，再放下來，做三下。', show: '舉右手 ✋',
    check: (p, t) => lift(p, 'right') >= t.right,
    meter: (p, t) => `右手 ${deg(lift(p, 'right'))}／目標 ${deg(t.right)}`,
  },
  {
    name: '雙手打開', needs: 'both', reps: 5, holdMs: 800, joints: ['left_wrist', 'right_wrist'],
    say: '兩隻手往旁邊打開，胸部挺起來，再收回來，做五下。', show: '雙手打開 🤗',
    check: (p) => {
      const sw = shoulderWidth(p);
      const l = point(p, 'left_wrist'), r = point(p, 'right_wrist');
      return !!(sw && l && r && Math.abs(l.x - r.x) >= sw * 1.8 && lift(p, 'left') >= 50 && lift(p, 'right') >= 50);
    },
    meter: (p) => {
      const sw = shoulderWidth(p);
      const l = point(p, 'left_wrist'), r = point(p, 'right_wrist');
      return sw && l && r ? `打開 ${(Math.abs(l.x - r.x) / sw).toFixed(1)} 倍肩寬／目標 1.8 倍` : '';
    },
  },
  {
    name: '拍拍手', needs: 'both', reps: 8, holdMs: 120, joints: ['left_wrist', 'right_wrist'],
    say: '最後跟我一起拍拍手，拍八下！', show: '拍拍手 👏',
    check: (p) => {
      const sw = shoulderWidth(p);
      const d = distance(point(p, 'left_wrist'), point(p, 'right_wrist'));
      return !!(sw && d !== null && d < sw * 0.7);
    },
  },
];
const PRAISE = ['做得真好！', '好棒喔！', '太厲害了！', '很有精神喔！'];

const $ = (id) => document.getElementById(id);
const topbar = mountTopbar('跟 Zenbo 做體操');
const robotBox = mountRobot($('robot'));
const stage = createStage($('stage'));

// ---------------------------------------------------------------- 機器人說話排隊

const sayQueue = [];
let lastSayAt = -Infinity;
let sayTimer = null;
/** 說一句話（同時在機器人螢幕上顯示 show）。排隊送，每句至少隔 SAY_GAP_MS */
function talk(text, show = null) {
  sayQueue.push({ text, show });
  pumpSay();
}
function pumpSay() {
  if (sayTimer || !sayQueue.length) return;
  const wait = Math.max(0, lastSayAt + SAY_GAP_MS - performance.now());
  sayTimer = setTimeout(() => {
    sayTimer = null;
    const { text, show } = sayQueue.shift();
    lastSayAt = performance.now();
    robot.say(text);
    if (show) robot.show(show);
    pumpSay();
  }, wait);
}
function clearTalk() {
  sayQueue.length = 0;
  clearTimeout(sayTimer);
  sayTimer = null;
}

// ---------------------------------------------------------------- 狀態

let state = 'ready';          // ready → calibrate → move ⇄ rest → done
let phaseEndAt = 0;           // calibrate／rest 結束的時間
let moveIdx = -1;
let reps = 0;
let hold = new Hold(800);
let lastRepAt = 0;
let nudged = false;
let records = [];             // 每個動作：{ reps, skipped, unable }
let reachL = new Reach(), reachR = new Reach();       // 暖身量到的最高角度
let bestL = new Reach(), bestR = new Reach();         // 整段體操裡的最高角度（給照服員看）
let targets = { left: 90, right: 90 };
const startHold = new Hold(2000);

function level() { return Number($('level').value) || 0.8; }

function computeTargets() {
  const t = {};
  for (const [side, reach] of [['left', reachL], ['right', reachR]]) {
    if (reach.max === null) t[side] = 90;                      // 暖身時沒看清楚：用平舉當目標
    else if (reach.max < UNABLE_DEG) t[side] = null;           // 這隻手不方便
    else t[side] = reach.target(level(), 45, 160);
  }
  return t;
}

function canDo(move) {
  const { left, right } = targets;
  if (move.needs === 'left') return left !== null;
  if (move.needs === 'right') return right !== null;
  if (move.needs === 'both') return left !== null && right !== null;
  return left !== null || right !== null;
}

function nextPossible(from) {
  for (let i = from; i < MOVES.length; i++) {
    if (canDo(MOVES[i])) return i;
    records[i] = { reps: 0, skipped: true, unable: true };
  }
  return -1;
}

// ---------------------------------------------------------------- 流程

function start() {
  clearTalk();
  state = 'calibrate';
  phaseEndAt = performance.now() + CALIBRATE_MS;
  moveIdx = -1;
  records = MOVES.map(() => null);
  reachL = new Reach(); reachR = new Reach();
  bestL = new Reach(); bestR = new Reach();
  $('start').disabled = true;
  $('start').textContent = '開始';
  $('skip').disabled = false;
  $('phase').textContent = '暖身';
  $('task').textContent = '兩隻手慢慢舉高，能舉多高就舉多高';
  $('sub').textContent = '';
  robot.expression('happy');
  talk('您好，我們來做體操！先暖身，請把兩隻手慢慢舉高，能舉多高就舉多高。', '暖身：雙手舉高');
  renderSteps();
}

function finishCalibration() {
  targets = computeTargets();
  const note = [];
  if (targets.left === null) note.push('左手不方便，左手的動作先略過');
  if (targets.right === null) note.push('右手不方便，右手的動作先略過');
  if (reachL.max === null && reachR.max === null) note.push('暖身時沒看清楚，先用平舉當目標');
  $('sub').textContent = `暖身：左手最高 ${deg(reachL.max)}、右手最高 ${deg(reachR.max)}。` + note.join('；');
  const first = nextPossible(0);
  if (first < 0) { finish(); return; }
  startMove(first, '暖身完成，我們開始囉！');
}

function startMove(i, intro = '') {
  state = 'move';
  moveIdx = i;
  reps = 0;
  const m = MOVES[i];
  hold = new Hold(m.holdMs);
  lastRepAt = performance.now();
  nudged = false;
  $('phase').textContent = `第 ${i + 1} 個動作`;
  $('task').textContent = m.show;
  robot.expression('expecting');
  clearTalk();                    // 還沒說的舊句子（例如照服員連按跳過）不要說了，直接說新的動作
  talk(intro + m.say, m.show);
  renderSteps();
}

function rep() {
  const m = MOVES[moveIdx];
  reps += 1;
  lastRepAt = performance.now();
  nudged = false;
  showBig(String(reps), 900);
  $('task-card').classList.remove('flash');
  void $('task-card').offsetWidth;
  $('task-card').classList.add('flash');
  if (reps >= m.reps) completeMove(false);
  else if (m.reps >= 5 && reps === Math.ceil(m.reps / 2)) talk(`很好，再 ${m.reps - reps} 下！`);
  renderSteps();
}

function completeMove(skipped) {
  records[moveIdx] = { reps, skipped, unable: false };
  const next = nextPossible(moveIdx + 1);
  if (!skipped) {
    robot.nod();
    robot.expression('happy');
    talk(PRAISE[Math.floor(Math.random() * PRAISE.length)], '做得好！👍');
  } else if (next >= 0) {
    talk('沒關係，我們休息一下，做下一個。');
  }
  if (next < 0) { finish(); return; }
  state = 'rest';
  moveIdx = next;                                  // 先記住下一個，休息完開始
  phaseEndAt = performance.now() + REST_MS;
  $('phase').textContent = '休息';
  $('task').textContent = '休息一下，深呼吸 😌';
  $('sub').textContent = `下一個：${MOVES[next].name}`;
  renderSteps();
}

function finish() {
  state = 'done';
  $('start').disabled = false;
  $('start').textContent = '再做一次';
  $('skip').disabled = true;
  $('phase').textContent = '完成';
  $('task').textContent = '今天的體操做完了 🎉';
  const total = records.reduce((s, r) => s + (r?.reps || 0), 0);
  $('sub').textContent = `一共做了 ${total} 下。手最高：左手 ${deg(bestL.max)}、右手 ${deg(bestR.max)}`
    + `（暖身時 ${deg(reachL.max)}、${deg(reachR.max)}）`;
  showBig('辛苦了！', 3000);
  robot.expression('proud');
  clearTalk();
  talk('今天的體操做完了，辛苦了！您做得非常好，記得喝點水喔。', '辛苦了 👏');
  setTimeout(() => robot.nod(), 1500);
  renderSteps();
}

function skip() {
  if (state === 'calibrate') finishCalibration();
  else if (state === 'move') completeMove(true);
  else if (state === 'rest') startMove(moveIdx);
}

// ---------------------------------------------------------------- 畫面

function renderSteps() {
  $('steps').innerHTML = '';
  MOVES.forEach((m, i) => {
    const li = document.createElement('li');
    const r = records[i];
    let right = `${m.reps} 下`;
    if (r?.unable) right = '略過';
    else if (r) right = r.skipped ? `跳過（${r.reps} 下）` : '完成 ✓';
    else if (state === 'move' && i === moveIdx) right = `${reps} / ${m.reps}`;
    if (r && !r.skipped) li.className = 'done';
    if ((state === 'move' || state === 'rest') && i === moveIdx) li.className = 'now';
    li.append(Object.assign(document.createElement('span'), { textContent: m.name }),
      Object.assign(document.createElement('span'), { textContent: right }));
    $('steps').append(li);
  });
}

let bigTimer;
function showBig(text, ms) {
  $('big').textContent = text;
  clearTimeout(bigTimer);
  bigTimer = setTimeout(() => { $('big').textContent = ''; }, ms);
}

function onPose(people, msg) {
  topbar.pose(msg);
  const p = pickPlayer(people);
  const move = state === 'move' ? MOVES[moveIdx] : null;
  stage.draw(people, { highlight: move ? move.joints : [] });
  $('hint').textContent = p ? '' : '請坐在鏡頭前面中間';

  if (state === 'done') return;    // 做完了：要照服員按「再做一次」，長輩開心舉手不會又重來一輪
  if (state === 'ready') {
    // 舉起任一隻手 2 秒就開始（有的長輩只有一隻手方便）
    const ok = !!p && Math.max(lift(p, 'left'), lift(p, 'right')) >= 100;
    if (startHold.update(ok)) start();
    $('hold').style.width = `${startHold.progress() * 100}%`;
    return;
  }

  if (p) { bestL.update(armLift(p, 'left')); bestR.update(armLift(p, 'right')); }

  if (state === 'calibrate') {
    if (p) { reachL.update(armLift(p, 'left')); reachR.update(armLift(p, 'right')); }
    $('sub').textContent = `左手 ${deg(reachL.max)}　右手 ${deg(reachR.max)}`;
    return;
  }

  if (state === 'move') {
    const ok = !!p && move.check(p, targets);
    $('hold').style.width = `${hold.progress() * 100}%`;
    if (move.meter) $('sub').textContent = p ? move.meter(p, targets) : '';
    if (hold.update(ok)) rep();
  }
}

// 時間到的事情（暖身結束、休息結束、很久沒做到）放這裡：畫面裡沒人也會照樣進行
setInterval(() => {
  const now = performance.now();
  if (state === 'calibrate' || state === 'rest') {
    const total = state === 'calibrate' ? CALIBRATE_MS : REST_MS;
    $('hold').style.width = `${Math.max(0, (phaseEndAt - now) / total) * 100}%`;
    if (now >= phaseEndAt) (state === 'calibrate' ? finishCalibration() : startMove(moveIdx));
  } else if (state === 'move' && !nudged && now - lastRepAt > NUDGE_MS) {
    nudged = true;
    robot.expression('expecting');
    talk('慢慢來，不用急，做到幾下都很棒！');
  }
}, 100);

$('start').onclick = start;
$('skip').onclick = skip;
$('level').onchange = () => { if (state === 'move' || state === 'rest') targets = computeTargets(); };
renderSteps();

connect({
  onPose,
  onHello: (msg) => topbar.hello(msg),
  onStatus: (connected) => topbar.status(connected),
  onRobot: (msg) => robotBox.show(msg),
});
