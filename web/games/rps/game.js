// 跟機器人猜拳：倒數「剪刀、石頭、布！」，「布」之後 1 秒內看你出什麼，機器人隨機出，先贏 3 局的人獲勝。
//
// 用到手部辨識：msg.hands[0].gesture 是 'rock'、'paper'、'scissors'…（伺服器已經從手指算好了）
import { connect, createStage, mainHand, GESTURES, Steady, robot } from '/common/pose.js';
import { mountTopbar, mountRobot } from '/common/ui.js';

const WIN_POINTS = 3;
const COUNT_MS = 700;            // 倒數每個字多久
const READ_MS = 1000;            // 喊完「布！」之後，看多久的手勢
const CHOICES = ['rock', 'paper', 'scissors'];
const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };   // 左邊贏右邊
const AS_RPS = { rock: 'rock', thumbs_up: 'rock', paper: 'paper', scissors: 'scissors' };  // 比讚也算石頭

const $ = (id) => document.getElementById(id);
const topbar = mountTopbar('跟機器人猜拳');
const robotBox = mountRobot($('robot'));
const stage = createStage($('stage'));

let state = 'ready';             // ready／countdown／reading／reveal／over
let you = 0, bot = 0;
let phaseAt = 0;                 // 這個階段從什麼時候開始
let seenVotes = {};              // 「布！」之後看到的手勢，各幾次
let overAt = 0;
const begin = new Steady(2000);  // 張開手掌 2 秒＝開始

function startMatch() {
  you = 0; bot = 0;
  $('you-pts').textContent = '0';
  $('bot-pts').textContent = '0';
  $('history').innerHTML = '';
  $('start').disabled = true;
  robot.say('來猜拳吧！先贏三局的人獲勝');
  setTimeout(startRound, 1500);
  state = 'wait';
}

function startRound() {
  state = 'countdown';
  phaseAt = performance.now();
  $('you').textContent = '❔';
  $('bot').textContent = '🤖';
  $('result').textContent = '';
  $('result').className = 'result';
  $('task').textContent = '準備出拳…';
  robot.say('剪刀、石頭、布！');
}

function reveal() {
  // 看最多次的那個手勢（避免剛好某一張畫面認錯）
  const [mine] = Object.entries(seenVotes).sort((a, b) => b[1] - a[1])[0] || [];
  if (!mine) {
    state = 'reveal';
    phaseAt = performance.now();
    $('result').textContent = '沒看到你出拳，再一次！';
    robot.say('我沒看到你出拳，再來一次');
    return;
  }
  const theirs = CHOICES[Math.floor(Math.random() * 3)];
  $('you').textContent = GESTURES[mine].emoji;
  $('bot').textContent = GESTURES[theirs].emoji;
  let outcome;
  if (mine === theirs) outcome = 'draw';
  else if (BEATS[mine] === theirs) outcome = 'win';
  else outcome = 'lose';

  const said = `我出${GESTURES[theirs].name}，`;
  const el = $('result');
  if (outcome === 'win') {
    you += 1;
    el.textContent = '你贏了！';
    el.className = 'result win';
    robot.say(said + '你贏了！');
  } else if (outcome === 'lose') {
    bot += 1;
    el.textContent = '機器人贏了';
    el.className = 'result lose';
    robot.say(said + '我贏了！');
  } else {
    el.textContent = '平手';
    el.className = 'result';
    robot.say(said + '平手！');
  }
  $('you-pts').textContent = String(you);
  $('bot-pts').textContent = String(bot);
  const chip = document.createElement('span');
  chip.className = outcome === 'win' ? 'w' : outcome === 'lose' ? 'l' : '';
  chip.textContent = `${GESTURES[mine].emoji}${GESTURES[theirs].emoji}`;
  $('history').append(chip);

  state = 'reveal';
  phaseAt = performance.now();
}

function finish() {
  state = 'over';
  overAt = performance.now();
  $('start').disabled = false;
  $('start').textContent = '再玩一次';
  const won = you > bot;
  $('task').textContent = '張開手掌 🖐️ 2 秒再玩一次';
  showBig(won ? '你獲勝！🏆' : '機器人獲勝', 3000);
  robot.say(won ? `${you} 比 ${bot}，你好厲害！` : `${bot} 比 ${you}，我贏了，再挑戰一次吧！`);
  setTimeout(() => (won ? robot.skill('flow.bow') : robot.nod()), 1200);
}

let bigTimer;
function showBig(text, ms) {
  $('big').textContent = text;
  clearTimeout(bigTimer);
  if (ms) bigTimer = setTimeout(() => { $('big').textContent = ''; }, ms);
}

function onPose(people, msg) {
  topbar.pose(msg);
  stage.draw(people, { skeleton: false, hands: msg.hands });
  const hand = mainHand(msg.hands);
  const g = hand && GESTURES[hand.gesture];
  $('seen').textContent = hand ? (g ? `${g.emoji} ${g.name}（${hand.count} 根手指）` : `${hand.count} 根手指`) : '（沒有看到手）';
  const now = performance.now();
  const t = now - phaseAt;

  if (state === 'ready' || state === 'over') {
    const cooling = state === 'over' && now - overAt < 3000;
    const paper = !cooling && hand?.gesture === 'paper' ? 'paper' : null;
    if (begin.update(paper, now)) startMatch();
    $('hold').style.width = `${begin.progress(now) * 100}%`;
  } else if (state === 'countdown') {
    const step = Math.floor(t / COUNT_MS);
    showBig(['剪刀…', '石頭…', '布！'][Math.min(step, 2)]);
    $('hold').style.width = `${Math.min(1, t / (COUNT_MS * 3)) * 100}%`;
    if (t >= COUNT_MS * 2) { state = 'reading'; phaseAt = now; seenVotes = {}; }
  } else if (state === 'reading') {
    const rps = hand && AS_RPS[hand.gesture];
    if (rps) seenVotes[rps] = (seenVotes[rps] || 0) + 1;
    if (t >= READ_MS) { showBig(''); reveal(); }
  } else if (state === 'reveal') {
    if (t >= 2500) {
      if (you >= WIN_POINTS || bot >= WIN_POINTS) finish();
      else startRound();
    }
  }
}

$('start').onclick = () => { if (state === 'ready' || state === 'over') startMatch(); };

connect({
  onPose,
  onHello: (msg) => {
    topbar.hello(msg);
    if (!msg.modules?.hands) {
      $('task').textContent = '手部辨識沒有開（看 config.json 的 hands，或重跑「1. 安裝環境」）';
      $('start').disabled = true;
    }
  },
  onStatus: (connected) => topbar.status(connected),
  onRobot: (msg) => robotBox.show(msg),
});
