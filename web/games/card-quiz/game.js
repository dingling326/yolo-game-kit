// 圖卡問答：題目說「請拿出貓」，把貓的圖卡拿穩 0.6 秒就判斷對錯。答對 10 題，看用了幾秒。
import { connect, createStage, mainCard, loadCards, Steady, robot } from '/common/pose.js';
import { mountTopbar, mountRobot } from '/common/ui.js';

const QUESTIONS = 10;

const $ = (id) => document.getElementById(id);
const topbar = mountTopbar('圖卡問答');
const robotBox = mountRobot($('robot'));
const stage = createStage($('stage'));
const CARDS = await loadCards();            // cards.json 的圖卡清單

let state = 'ready';            // ready：等開始／playing：遊戲中／over：結束
let target = null;              // 這一題要的卡
let done = 0;
let wrong = 0;
let startAt = 0;
let overAt = 0;
let waitUntil = 0;              // 答對後停一下再出下一題
let holding = null;             // 現在鏡頭看到的卡（id）
const answer = new Steady(600);  // 同一張卡拿穩 0.6 秒才判斷
const begin = new Steady(2000);  // 還沒開始時：任何一張卡拿 2 秒 = 開始
let best = null;
try { best = Number(localStorage.getItem('card-quiz-best')) || null; } catch {}
$('best').textContent = best ? `${best.toFixed(1)} 秒` : '—';

function ask() {
  const choices = CARDS.filter((c) => c !== target);
  target = choices[Math.floor(Math.random() * choices.length)];
  $('pic').textContent = target.emoji;
  $('task').textContent = target.name;
  $('en').textContent = target.en;
  answer.ignore(holding);       // 還拿著上一題的卡不算錯，要先拿開
  robot.say(`請拿出${target.name}`);
}

function start() {
  state = 'playing';
  done = 0;
  wrong = 0;
  startAt = performance.now();
  waitUntil = 0;
  target = null;
  $('done').textContent = `0/${QUESTIONS}`;
  $('wrong').textContent = '0';
  $('start').disabled = true;
  $('skip').disabled = false;
  ask();
}

function finish() {
  state = 'over';
  overAt = performance.now();
  const seconds = (overAt - startAt) / 1000;
  target = null;
  $('start').disabled = false;
  $('start').textContent = '再玩一次';
  $('skip').disabled = true;
  $('pic').textContent = '🏆';
  $('task').textContent = `${seconds.toFixed(1)} 秒`;
  $('en').textContent = '按「再玩一次」，或拿任何一張圖卡 2 秒';
  showBig('完成！', 'good', 2500);
  if (best === null || seconds < best) {
    best = seconds;
    $('best').textContent = `${best.toFixed(1)} 秒`;
    try { localStorage.setItem('card-quiz-best', String(best)); } catch {}
  }
  robot.say(`完成了！你用了 ${Math.round(seconds)} 秒，拿錯 ${wrong} 次。`);
  setTimeout(() => robot.nod(), 1000);
}

let bigTimer;
function showBig(text, kind, ms) {
  const el = $('big');
  el.textContent = text;
  el.className = 'big ' + (kind || '');
  clearTimeout(bigTimer);
  bigTimer = setTimeout(() => { el.textContent = ''; }, ms);
}

function onPose(people, msg) {
  topbar.pose(msg);
  const card = mainCard(msg.cards);          // 最靠近鏡頭的那張卡
  stage.draw(people, { skeleton: false, cards: msg.cards, goodCard: target?.id });
  $('seen').textContent = card ? `${card.emoji} ${card.name}` : '（沒有看到圖卡）';
  holding = card?.id ?? null;
  const now = performance.now();

  if (state !== 'playing') {
    const cooling = state === 'over' && now - overAt < 3000;   // 剛結束 3 秒內不算
    if (begin.update(cooling ? null : card?.id) !== null) start();
    $('hold').style.width = `${begin.progress() * 100}%`;
    return;
  }
  if (now < waitUntil) return;

  const id = answer.update(holding);
  $('hold').style.width = `${answer.progress() * 100}%`;
  if (id === null) return;

  if (id === target.id) {
    done += 1;
    $('done').textContent = `${done}/${QUESTIONS}`;
    $('task-card').classList.remove('flash');
    void $('task-card').offsetWidth;
    $('task-card').classList.add('flash');
    showBig('答對了！', 'good', 900);
    if (done >= QUESTIONS) { finish(); return; }
    waitUntil = now + 1200;
    setTimeout(ask, 1200);
  } else {
    wrong += 1;
    $('wrong').textContent = String(wrong);
    const shown = CARDS.find((c) => c.id === id);
    showBig(`這是${shown.name}`, 'bad', 1200);
    robot.say(`這是${shown.name}，不是${target.name}喔`);
  }
}

setInterval(() => {
  if (state === 'playing') $('clock').textContent = ((performance.now() - startAt) / 1000).toFixed(1);
}, 100);

$('start').onclick = start;
$('skip').onclick = () => { if (state === 'playing') ask(); };

connect({
  onPose,
  onHello: (msg) => topbar.hello(msg),
  onStatus: (connected) => topbar.status(connected),
  onRobot: (msg) => robotBox.show(msg),
});
