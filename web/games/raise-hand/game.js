// 舉手挑戰（長輩版）：機器人說「請舉左手」，長輩坐著舉手，手舉到肩膀高、維持 1 秒就算做到。
//
// 給長輩用的設計：
//   · 不倒數：固定 8 或 10 題，做完就結束；每題至少停 5 秒（「慢」是 8 秒），指令不會一閃而過
//   · 先練習 2 題（不算星星），再開始算
//   · 難度：1 左手、右手 → 2 加上雙手 → 3 加上「先左手再右手」兩個步驟。照服員可以開「反向指令」
//   · 指令卡深底大字，左手藍、右手橘；機器人（電腦喇叭）同時慢慢唸出來
//   · 判定寬鬆：手腕舉到肩膀高就算（手腕跑出畫面時，手肘比肩膀高也算）；只看上半身，坐著做
//   · 做到：「太棒了！」＋星星＋拍手聲；做錯不說錯、不扣分，只說「再試一次喔」並重說指令
//   · 用星星累積，最後「今天你得到 8 顆星」，不排名、不比較
//   · 一題很久沒做到：再說一次指令；試了 3 次還不行就溫和地換下一題（不算星星）
//   · 團體模式：畫面裡每個人都算；照服員可以暫停、跳題；一輪超過 5 分鐘自動結束休息
//   · 左右鏡像：畫面像照鏡子；練習時一直舉相反的手，會提醒照服員可能要勾「左右對調」
import { connect, createStage, point, pickPlayer, Hold, robot } from '/common/pose.js';
import { mountTopbar, mountRobot } from '/common/ui.js';
import { voice } from '/common/voice.js';

const COLOR = { left: '#3b82f6', right: '#f97316' };
const ZH = { left: '左', right: '右' };
const SPEED = {
  normal: { minShow: 5000, retry: 15000 },   // 每題至少顯示幾毫秒；多久沒做到就再說一次
  slow: { minShow: 8000, retry: 20000 },
};
const HOLD_MS = 1000;        // 動作維持多久才算做到
const WRONG_MS = 1200;       // 舉錯手維持多久才提醒（比做到久一點，避免換手的瞬間被當成錯）
const START_MS = 3000;       // 還沒開始時：雙手舉高 3 秒 = 開始
const FEEDBACK_MS = 2800;    // 做到之後，稱讚停留多久
const PRACTICE = 2;          // 練習題數（不算星星）
const TRIES = 3;             // 同一題提醒幾次之後就換下一題
const MAX_MS = 5 * 60 * 1000;   // 一輪最長 5 分鐘
const SAY_GAP_MS = 3200;     // 機器人兩句話至少隔這麼久
const PRAISE = ['太棒了！', '做得很好！', '好厲害！', '很好喔！', '真不錯！'];

const $ = (id) => document.getElementById(id);
const topbar = mountTopbar('舉手挑戰');
const robotBox = mountRobot($('robot'));
const stage = createStage($('stage'));

// ---------------------------------------------------------------- 照服員設定

const SETTINGS = ['level', 'count', 'speed', 'reverse', 'group', 'swap'];
try {
  const saved = JSON.parse(localStorage.getItem('raise-hand-settings')) || {};
  for (const k of SETTINGS) {
    if (!(k in saved)) continue;
    if ($(k).type === 'checkbox') $(k).checked = !!saved[k]; else $(k).value = saved[k];
  }
} catch {}
for (const k of SETTINGS) {
  $(k).onchange = () => {
    const out = {};
    for (const s of SETTINGS) out[s] = $(s).type === 'checkbox' ? $(s).checked : $(s).value;
    try { localStorage.setItem('raise-hand-settings', JSON.stringify(out)); } catch {}
  };
}
const setting = (k) => ($(k).type === 'checkbox' ? $(k).checked : $(k).value);

// ---------------------------------------------------------------- 時間（暫停的時候不算）

let pausedAt = null;
let pausedTotal = 0;
const clock = () => (pausedAt ?? performance.now()) - pausedTotal;

// ---------------------------------------------------------------- 說話

const sayQueue = [];
let lastSayAt = -Infinity;
let sayTimer = null;
let speechEnd = 0;              // 估計機器人什麼時候說完（中文每個字約 0.3 秒）
const speechMs = (text) => 800 + (text.match(/[一-鿿]/g) || []).length * 300;
/** 機器人已經把指令說完了嗎（還沒說完就判斷，長輩根本還不知道要做什麼） */
const spoken = () => !sayQueue.length && !sayTimer && performance.now() >= speechEnd - 1200;
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
    speechEnd = lastSayAt + speechMs(text);
    robot.say(text);                          // 唸出來由 ui.js 處理（模擬機器人時用電腦喇叭）
    if (show) robot.show(show);
    pumpSay();
  }, wait);
}
function clearTalk() {
  sayQueue.length = 0;
  clearTimeout(sayTimer);
  sayTimer = null;
}

// ---------------------------------------------------------------- 題目

/**
 * 一題：
 *   type: 'one'（舉某一隻手）｜'any'（哪隻手都可以）｜'both'（雙手）｜'seq'（兩個步驟）｜'reverse'（相反的手）
 *   side／steps：要舉哪隻手；text：大字；sub：黃色小字；say：機器人說的話
 */
function oneHand(side) {
  const name = `${ZH[side]}手`;
  return pick([
    { type: 'one', side, text: `請舉${name}`, sub: '', say: `請舉起你的${name}。` },
    { type: 'one', side, text: `請舉${name}`, sub: '像在拿高處的東西', say: `像在拿高處的東西一樣，舉起你的${name}。` },
    { type: 'one', side, text: `請舉${name}`, sub: '像在跟朋友打招呼', say: `像在跟朋友打招呼一樣，舉起你的${name}。` },
  ]);
}
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function makeTask(level, practice) {
  if (practice) return { ...oneHand(practice === 1 ? 'right' : 'left'), sub: '練習' };
  const pool = [() => oneHand('left'), () => oneHand('right'), () => oneHand('left'), () => oneHand('right'),
    () => ({ type: 'any', text: '揮揮手', sub: '跟我一起打招呼', say: '跟我一起揮手打招呼，舉起一隻手揮一揮。' })];
  if (level >= 2) {
    pool.push(() => ({ type: 'both', text: '雙手舉起來', sub: '像在伸懶腰', say: '兩隻手一起舉起來，像在伸懶腰。' }));
    pool.push(() => ({ type: 'both', text: '雙手舉起來', sub: '萬歲！', say: '兩隻手一起舉高，喊萬歲！' }));
  }
  if (level >= 3) {
    pool.push(() => ({ type: 'seq', steps: ['left', 'right'], text: '先左手，再右手', sub: '一隻一隻來',
      say: '先舉左手，放下來，再舉右手。' }));
    pool.push(() => ({ type: 'seq', steps: ['right', 'left'], text: '先右手，再左手', sub: '一隻一隻來',
      say: '先舉右手，放下來，再舉左手。' }));
  }
  if (setting('reverse') && level >= 2) {
    for (const robotSide of ['left', 'right']) {
      const side = robotSide === 'left' ? 'right' : 'left';
      pool.push(() => ({ type: 'reverse', robotSide, side, text: '舉相反的手', sub: `我舉${ZH[robotSide]}手`,
        say: `我舉${ZH[robotSide]}手，請你舉起和我相反的那一隻手。` }));
    }
  }
  let t;
  do { t = pick(pool)(); } while (pool.length > 1 && lastKey && keyOf(t) === lastKey);
  return t;
}
const keyOf = (t) => `${t.type}:${t.side || ''}${(t.steps || []).join('')}${t.robotSide || ''}`;

/** 舉手的圖示（SVG）。手心朝前、像照鏡子：左手畫在左邊，大拇指朝身體中間 */
function handIcon(side, cls = '') {
  const flip = side === 'right' ? 'transform="translate(100 0) scale(-1 1)"' : '';
  const c = COLOR[side];
  return `<div class="hand ${side} ${cls}">
    <svg viewBox="0 0 100 120" aria-hidden="true"><g ${flip} fill="${c}" stroke="#0b1220" stroke-width="3" stroke-linejoin="round">
      <rect x="20" y="20" width="13" height="46" rx="6.5"/>
      <rect x="35" y="8" width="13" height="58" rx="6.5"/>
      <rect x="50" y="6" width="13" height="60" rx="6.5"/>
      <rect x="65" y="14" width="13" height="52" rx="6.5"/>
      <rect x="70" y="50" width="14" height="38" rx="7" transform="rotate(32 77 86)"/>
      <path d="M20 54 h58 v28 q0 30 -29 30 q-29 0 -29 -30 z"/>
    </g></svg>
    <b>${ZH[side]}手</b></div>`;
}

function renderIcons(t, step = 0) {
  let html = '';
  if (t.type === 'one') html = handIcon(t.side);
  else if (t.type === 'both' || t.type === 'any') html = handIcon('left') + handIcon('right');
  else if (t.type === 'seq') {
    html = handIcon(t.steps[0], step > 0 ? 'done' : '') + '<span class="arrow">→</span>' + handIcon(t.steps[1], step > 0 ? '' : 'dim');
  } else if (t.type === 'reverse') {
    html = `<div class="robot-says">機器人舉<br><span style="color:${COLOR[t.robotSide]}">${ZH[t.robotSide]}手</span></div>` +
      '<span class="arrow">⇄</span><div class="robot-says">你舉<br>相反的手</div>';
  }
  $('icons').innerHTML = html;
}

// ---------------------------------------------------------------- 判斷手有沒有舉起來

/** 寬鬆：手腕到肩膀高就算；手腕看不到（舉太高跑出畫面）時，手肘比肩膀高也算 */
function up(p, side) {
  if (!p) return false;
  if (setting('swap')) side = side === 'left' ? 'right' : 'left';   // 攝影機左右相反時
  const s = point(p, side + '_shoulder');
  if (!s) return false;
  const w = point(p, side + '_wrist');
  if (w) return w.y < s.y + 0.02;
  const e = point(p, side + '_elbow');
  return !!(e && e.y < s.y - 0.02);
}
const anyUp = (p) => up(p, 'left') || up(p, 'right');

/** 這個人現在做對了嗎：'ok'｜'wrong'（舉了另一隻手）｜null（還沒做） */
function judge(t, p, step) {
  const L = up(p, 'left'), R = up(p, 'right');
  const alone = (side) => (side === 'left' ? L && !R : R && !L);
  const other = (side) => (side === 'left' ? 'right' : 'left');
  switch (t.type) {
    case 'one':
    case 'reverse':
      return alone(t.side) ? 'ok' : alone(other(t.side)) ? 'wrong' : null;
    case 'any':
      return L || R ? 'ok' : null;
    case 'both':
      return L && R ? 'ok' : null;
    case 'seq':
      if (step === 0) return alone(t.steps[0]) ? 'ok' : alone(t.steps[1]) ? 'wrong' : null;
      return up(p, t.steps[1]) ? 'ok' : null;
  }
  return null;
}

// ---------------------------------------------------------------- 遊戲流程

let state = 'ready';            // ready／playing／over
let task = null;
let lastKey = null;
let step = 0;                   // 兩步驟題：現在第幾步
let phase = 'down';             // down：等大家把手放下／go：在做／done：做到了，稱讚中
let qIndex = 0;                 // 第幾題（包含練習）
let total = 8;
let stars = 0;
let startedAt = 0, shownAt = 0, promptAt = 0, nextAt = 0, tries = 0;
let downSince = null, toldDown = false;
let wrongArmed = true;          // 舉錯提醒過一次之後，要先把手放下才會再提醒
let swapHints = 0;              // 練習時舉了「剛好相反」的手幾次（可能是鏡頭左右相反）
let overAt = 0;
const okHold = new Hold(HOLD_MS);
const wrongHold = new Hold(WRONG_MS);
const startHold = new Hold(START_MS);

const isPractice = () => qIndex < PRACTICE;

function start() {
  clearTalk();
  state = 'playing';
  total = Number(setting('count')) || 8;
  stars = 0; qIndex = 0; lastKey = null; swapHints = 0;
  pausedAt = null; pausedTotal = 0;
  startedAt = clock();
  renderStars();
  $('notice').hidden = true;
  $('start').disabled = true;
  $('start').textContent = '開始';
  for (const id of ['repeat', 'pause', 'skip']) $(id).disabled = false;
  $('pause').textContent = '暫停';
  robot.expression('happy');
  talk('我們來做舉手運動。坐著做就可以，手舉到肩膀高就算數。感覺累了，隨時可以休息。');
  talk('先來練習兩題。');
  ask();
}

function ask() {
  task = makeTask(Number(setting('level')) || 1, isPractice() ? qIndex + 1 : 0);
  lastKey = keyOf(task);
  step = 0; tries = 0; phase = 'down'; downSince = null; toldDown = false; wrongArmed = true;
  okHold.reset(); wrongHold.reset();
  shownAt = promptAt = clock();
  const practice = isPractice();
  $('tag').textContent = practice ? `練習 ${qIndex + 1}` : `第 ${qIndex - PRACTICE + 1} 題／共 ${total} 題`;
  $('tag').classList.toggle('practice', practice);
  $('task').textContent = task.text;
  $('sub').textContent = practice ? '練習，不用緊張' : task.sub;
  renderIcons(task);
  talk(task.say, task.text);
}

function repeatTask(prefix = '') {
  if (state !== 'playing' || !task) return;
  promptAt = clock();
  const say = task.type === 'seq' && step === 1 ? `現在換${ZH[task.steps[1]]}手。` : task.say;
  talk(prefix + say, task.text);
}

function success(count) {
  if (task.type === 'seq' && step === 0) {     // 兩步驟：第一步做到了
    step = 1;
    okHold.reset(); wrongHold.reset();
    renderIcons(task, 1);
    promptAt = clock();
    talk(`很好！現在換${ZH[task.steps[1]]}手。`);
    return;
  }
  phase = 'done';
  const practice = isPractice();
  if (!practice) { stars += 1; renderStars(true); }
  $('task-card').classList.remove('flash');
  void $('task-card').offsetWidth;
  $('task-card').classList.add('flash');
  const praise = pick(PRAISE);
  showBig(praise, 'good', FEEDBACK_MS - 300);
  burst();
  clap();
  robot.nod();
  clearTalk();
  if (count > 1) talk(`${praise}有 ${count} 位做到了！`);
  else talk(practice ? `${praise}練習做得很好。` : praise);
  nextAt = Math.max(clock() + FEEDBACK_MS, shownAt + SPEED[setting('speed')].minShow);
}

function wrong(p) {
  wrongArmed = false;
  wrongHold.reset();
  showBig('再試一次喔', 'soft', 1800);
  // 練習時舉了「剛好相反」的那隻手：記下來，可能是鏡頭左右相反
  if (isPractice() && task.type === 'one' && p) {
    swapHints += 1;
    if (swapHints >= 2) {
      $('notice').textContent = '練習時兩次都舉了相反的手。如果長輩其實舉對了，可能是攝影機左右相反，請勾選「左右對調」。';
      $('notice').hidden = false;
      $('setup').open = true;
    }
  }
  repeatTask('再試一次喔。');                  // 不清掉前面的話（例如開場說明），排在後面說
}

function next() {
  qIndex += 1;
  if (qIndex === PRACTICE) talk('練習完了，接下來開始算星星囉！');
  if (qIndex >= PRACTICE + total) { finish(); return; }
  ask();
}

function giveUp() {
  // 很久都沒做到：不算錯，溫和地換下一題
  phase = 'done';
  clearTalk();
  talk('沒關係，我們做下一個。');
  nextAt = clock() + 2500;
}

function finish(tooLong = false) {
  state = 'over';
  overAt = performance.now();
  task = null;
  phase = 'down';
  $('start').disabled = false;
  $('start').textContent = '再玩一次';
  for (const id of ['repeat', 'pause', 'skip']) $(id).disabled = true;
  $('tag').textContent = '今天的成果';
  $('tag').classList.remove('practice');
  $('icons').innerHTML = '';
  $('task').textContent = `得到 ${stars} 顆星`;
  $('sub').textContent = '謝謝你，辛苦了！';
  $('stars-text').textContent = `今天你得到 ${stars} 顆星`;
  showBig(`${stars} 顆星`, 'good', 3500);
  if (stars) { burst(); clap(); }
  robot.expression('proud');
  clearTalk();
  if (tooLong) talk('我們已經做了五分鐘，先休息一下吧。');
  talk(`今天你得到 ${stars} 顆星，做得很好，謝謝你陪我運動！`, `${stars} 顆星`);
  setTimeout(() => robot.nod(), 1500);
}

function togglePause() {
  if (state !== 'playing') return;
  if (pausedAt === null) {
    pausedAt = performance.now();
    $('pause').textContent = '繼續';
    $('tag').textContent = '休息中';
    clearTalk();
    talk('我們休息一下，準備好了再繼續。');
  } else {
    pausedTotal += performance.now() - pausedAt;
    pausedAt = null;
    $('pause').textContent = '暫停';
    $('tag').textContent = isPractice() ? `練習 ${qIndex + 1}` : `第 ${qIndex - PRACTICE + 1} 題／共 ${total} 題`;
    okHold.reset(); wrongHold.reset();
    talk('好，我們繼續。');
    repeatTask();
  }
}

// ---------------------------------------------------------------- 畫面效果

function renderStars(pop = false) {
  $('stars').innerHTML = '';
  for (let i = 0; i < stars; i++) {
    const s = document.createElement('span');
    s.textContent = '★';
    if (pop && i === stars - 1) s.className = 'new';
    $('stars').append(s);
  }
  $('stars-text').textContent = stars ? `已經得到 ${stars} 顆星` : '做對一題，就得到一顆星';
}

let bigTimer;
function showBig(text, kind, ms) {
  const el = $('big');
  el.textContent = text;
  el.className = 'big ' + (kind || '');
  clearTimeout(bigTimer);
  bigTimer = setTimeout(() => { el.textContent = ''; }, ms);
}

function burst() {
  const box = $('burst');
  for (let i = 0; i < 10; i++) {
    const s = document.createElement('span');
    s.textContent = '★';
    const a = (Math.PI * 2 * i) / 10 + Math.random() * 0.4;
    const r = 160 + Math.random() * 120;
    s.style.setProperty('--dx', `${Math.cos(a) * r}px`);
    s.style.setProperty('--dy', `${Math.sin(a) * r}px`);
    box.append(s);
    setTimeout(() => s.remove(), 1400);
  }
}

/** 拍手聲：用雜音做出四下拍手（不用另外放音效檔） */
let actx = null;
function clap() {
  try {
    actx ??= new AudioContext();
    actx.resume();
    const t0 = actx.currentTime + 0.05;
    for (let i = 0; i < 4; i++) {
      const t = t0 + i * 0.17 + Math.random() * 0.03;
      const len = Math.floor(actx.sampleRate * 0.12);
      const buf = actx.createBuffer(1, len, actx.sampleRate);
      const d = buf.getChannelData(0);
      for (let j = 0; j < len; j++) d[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / len, 6);
      const src = actx.createBufferSource();
      src.buffer = buf;
      const f = actx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 0.7;
      const g = actx.createGain();
      g.gain.value = 0.8;
      src.connect(f).connect(g).connect(actx.destination);
      src.start(t);
    }
  } catch {}
}

/** 在攝影機畫面上標出左右手：手腕畫藍色（左）、橘色（右）的圓圈和字 */
function drawSides(people) {
  const { ctx, canvas } = stage;
  const dpr = devicePixelRatio;
  const w = canvas.width, h = canvas.height;
  for (const p of people) {
    for (const side of ['left', 'right']) {
      const real = setting('swap') ? (side === 'left' ? 'right' : 'left') : side;
      const at = point(p, real + '_wrist') || point(p, real + '_elbow');
      if (!at) continue;
      const x = at.x * w, y = at.y * h, r = (up(p, side) ? 34 : 24) * dpr;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = COLOR[side];
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.translate(x, y);
      ctx.scale(-1, 1);                       // 畫面是鏡像的，字要翻回來
      ctx.font = `800 ${r * 1.1}px "Microsoft JhengHei", "PingFang TC", sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ZH[side], 0, r * 0.06);
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------- 每張畫面

function onPose(people, msg) {
  topbar.pose(msg);
  const group = setting('group');
  const players = group ? (people || []) : [pickPlayer(people) || people?.[0]].filter(Boolean);
  stage.draw(people, { skeleton: true, lineWidth: 3 });
  drawSides(players);

  if (state !== 'playing') {
    // 還沒開始：雙手舉高 3 秒就開始（剛結束的 5 秒內不算，免得歡呼舉手就直接重開）
    const cooling = state === 'over' && performance.now() - overAt < 5000;
    const both = !cooling && players.some((p) => up(p, 'left') && up(p, 'right'));
    if (startHold.update(both)) start();
    $('hold').style.width = `${startHold.progress() * 100}%`;
    return;
  }
  if (pausedAt !== null || !task) return;
  const now = clock();

  if (phase === 'down') {
    // 新的一題：先等大家把手放下，上一題還舉著的手才不會直接算
    const raised = players.some(anyUp);
    if (!raised) {
      downSince ??= now;
      if (now - downSince > 400 && spoken()) { phase = 'go'; promptAt = now; }   // 手放下了、指令也說完了才開始看
    } else {
      downSince = null;
      if (!toldDown && spoken() && now - shownAt > 2500) { toldDown = true; talk('先把手放下來喔。'); }
    }
    $('hold').style.width = '0%';
    return;
  }
  if (phase !== 'go') { $('hold').style.width = '0%'; return; }

  const results = players.map((p) => judge(task, p, step));
  const okCount = results.filter((r) => r === 'ok').length;
  const wrongP = !group && results[0] === 'wrong' ? players[0] : null;
  if (!players.some(anyUp)) wrongArmed = true;

  $('hold').style.width = `${okHold.progress() * 100}%`;
  if (okHold.update(okCount > 0)) { success(okCount); return; }
  if (wrongHold.update(!!wrongP && wrongArmed)) wrong(wrongP);
}

// 計時：每題的停留時間、很久沒做到要提醒、一輪最長 5 分鐘（暫停的時候不算）
setInterval(() => {
  if (state !== 'playing' || pausedAt !== null || !task) return;
  const now = clock();
  if (now - startedAt > MAX_MS) { finish(true); return; }
  if (phase === 'done') { if (now >= nextAt) next(); return; }
  if (phase === 'go' && now - promptAt > SPEED[setting('speed')].retry) {
    tries += 1;
    if (tries >= TRIES) giveUp();
    else repeatTask('慢慢來，我們再做一次。');
  }
}, 200);

$('start').onclick = start;
$('repeat').onclick = () => repeatTask();
$('pause').onclick = togglePause;
$('skip').onclick = () => {
  if (state !== 'playing' || !task || phase === 'done') return;
  clearTalk();
  talk('好，我們換下一個。');
  phase = 'done';
  nextAt = clock() + 1500;
};

// ---------------------------------------------------------------- 語音

voice.command(['暫停', '休息', '停一下', '等一下', 'pause'], () => {
  if (state !== 'playing' || pausedAt !== null) return false;
  togglePause();
});
voice.command(['繼續', '好了', 'continue', 'resume'], () => {
  if (state !== 'playing' || pausedAt === null) return false;
  togglePause();
});

connect({
  onPose,
  onHello: (msg) => topbar.hello(msg),
  onStatus: (connected) => topbar.status(connected),
  onRobot: (msg) => robotBox.show(msg),
});
