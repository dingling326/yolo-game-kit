// 舉手挑戰：照指示舉手，維持 0.4 秒算做對，30 秒內看能做對幾次。
import { connect, createStage, isHandUp, mainPerson, Hold, robot } from '/common/pose.js';
import { mountTopbar, mountRobot } from '/common/ui.js';

const ROUND_SECONDS = 30;

// 每一題：要顯示的文字、要看哪些關節、怎樣算做對
const TASKS = [
  { text: '舉起左手 ✋', joints: ['left_wrist'],
    check: (p) => isHandUp(p, 'left') && !isHandUp(p, 'right') },
  { text: '舉起右手 ✋', joints: ['right_wrist'],
    check: (p) => isHandUp(p, 'right') && !isHandUp(p, 'left') },
  { text: '雙手舉高 🙌', joints: ['left_wrist', 'right_wrist'],
    check: (p) => isHandUp(p, 'left') && isHandUp(p, 'right') },
];

const $ = (id) => document.getElementById(id);
const topbar = mountTopbar('舉手挑戰');
const robotBox = mountRobot($('robot'));
const stage = createStage($('stage'));

let state = 'ready';            // ready：等開始／playing：遊戲中／over：時間到
let score = 0;
let task = null;
let endAt = 0;
let overAt = 0;
const hold = new Hold(400);      // 做對要維持 0.4 秒
const startHold = new Hold(2000); // 雙手舉高 2 秒 = 開始（不用碰鍵盤）
let best = 0;
try { best = Number(localStorage.getItem('raise-hand-best')) || 0; } catch {}
$('best').textContent = best ? `${best} 分` : '—';

function nextTask() {
  const choices = TASKS.filter((t) => t !== task);     // 不要連續出同一題
  task = choices[Math.floor(Math.random() * choices.length)];
  hold.reset();
  $('task').textContent = task.text;
}

function start() {
  state = 'playing';
  score = 0;
  $('score').textContent = '0';
  $('start').disabled = true;
  endAt = performance.now() + ROUND_SECONDS * 1000;
  task = null;
  nextTask();
  showBig('開始！', 800);
  robot.say('開始囉，照畫面的指示做！');
}

function finish() {
  state = 'over';
  overAt = performance.now();
  task = null;
  $('start').disabled = false;
  $('start').textContent = '再玩一次';
  $('task').textContent = '按「再玩一次」，或雙手舉高 2 秒';
  showBig(`${score} 分`, 3000);
  if (score > best) {
    best = score;
    $('best').textContent = `${best} 分`;
    try { localStorage.setItem('raise-hand-best', String(best)); } catch {}
  }
  robot.say(score >= 10 ? `太厲害了，你得了 ${score} 分！` : `時間到，你得了 ${score} 分，再挑戰一次吧！`);
  setTimeout(() => robot.nod(), 1000);
}

let bigTimer;
function showBig(text, ms) {
  $('big').textContent = text;
  clearTimeout(bigTimer);
  bigTimer = setTimeout(() => { $('big').textContent = ''; }, ms);
}

function onPose(people, msg) {
  topbar.pose(msg);
  const person = mainPerson(people);
  stage.draw(people, { highlight: task ? task.joints : [] });

  if (state !== 'playing') {
    // 還沒開始：雙手舉高 2 秒就開始（剛結束的 3 秒內不算，免得歡呼舉手就直接重開）
    const cooling = state === 'over' && performance.now() - overAt < 3000;
    const both = !cooling && !!person && isHandUp(person, 'left') && isHandUp(person, 'right');
    if (startHold.update(both)) start();
    $('hold').style.width = `${startHold.progress() * 100}%`;
    return;
  }

  const ok = !!person && task.check(person);
  $('hold').style.width = `${hold.progress() * 100}%`;
  if (hold.update(ok)) {
    score += 1;
    $('score').textContent = String(score);
    $('task-card').classList.remove('flash');
    void $('task-card').offsetWidth;
    $('task-card').classList.add('flash');
    if (score % 5 === 0) robot.say(`${score} 分了，好棒！`);
    nextTask();
  }
}

// 倒數計時（跟畫面更新分開，沒有人也照樣倒數）
setInterval(() => {
  if (state !== 'playing') return;
  const left = Math.max(0, endAt - performance.now());
  $('time').style.width = `${(left / (ROUND_SECONDS * 1000)) * 100}%`;
  $('time-text').textContent = `${Math.ceil(left / 1000)} 秒`;
  if (left === 0) finish();
}, 100);

$('start').onclick = start;

connect({
  onPose,
  onHello: (msg) => topbar.hello(msg),
  onStatus: (connected) => topbar.status(connected),
  onRobot: (msg) => robotBox.show(msg),
});
