// 戳泡泡：泡泡從下面飄上來，手腕碰到就戳破。金色泡泡 3 分。畫面裡每個人的手都算（可以一起玩）。
//
// 跟「舉手挑戰」不一樣的地方：
//   · 不是判斷「姿勢」，是用手的「位置」做碰撞判斷
//   · 泡泡要一直動，所以用 requestAnimationFrame 每秒畫 60 次；辨識結果（每秒 15～30 次）只是更新手的位置
import { connect, createStage, point, isHandUp, mainPerson, Hold, robot } from '/common/pose.js';
import { mountTopbar, mountRobot } from '/common/ui.js';

const ROUND_SECONDS = 45;
const HAND_RADIUS = 0.05;        // 手的大小（以畫面高度為 1）
const GOLD_CHANCE = 0.12;        // 金色泡泡的機率

const $ = (id) => document.getElementById(id);
const topbar = mountTopbar('戳泡泡');
const robotBox = mountRobot($('robot'));
const stage = createStage($('stage'));

let people = [];                 // 最新的辨識結果
let bubbles = [];                // {x, y, r, speed, phase, gold}：x、y 是 0～1，r 以畫面高度為 1
let pops = [];                   // 戳破的動畫 {x, y, r, gold, t}
let state = 'ready';
let score = 0;
let endAt = 0;
let overAt = 0;
let nextSpawn = 0;
const startHold = new Hold(2000);
let best = 0;
try { best = Number(localStorage.getItem('bubble-pop-best')) || 0; } catch {}
$('best').textContent = best ? `${best} 分` : '—';

function start() {
  state = 'playing';
  score = 0;
  bubbles = [];
  pops = [];
  $('score').textContent = '0';
  $('start').disabled = true;
  $('task').textContent = '用手戳破泡泡！';
  endAt = performance.now() + ROUND_SECONDS * 1000;
  nextSpawn = 0;
  showBig('開始！', 800);
  robot.say('開始戳泡泡！');
}

function finish() {
  state = 'over';
  overAt = performance.now();
  bubbles = [];
  $('start').disabled = false;
  $('start').textContent = '再玩一次';
  $('task').textContent = '按「再玩一次」，或雙手舉高 2 秒';
  showBig(`${score} 分`, 3000);
  if (score > best) {
    best = score;
    $('best').textContent = `${best} 分`;
    try { localStorage.setItem('bubble-pop-best', String(best)); } catch {}
  }
  robot.say(`時間到！你戳破了 ${score} 分的泡泡`);
  setTimeout(() => robot.nod(), 1000);
}

let bigTimer;
function showBig(text, ms) {
  $('big').textContent = text;
  clearTimeout(bigTimer);
  bigTimer = setTimeout(() => { $('big').textContent = ''; }, ms);
}

/** 畫面裡所有人的手腕（看得到的才算） */
function hands() {
  const out = [];
  for (const p of people) {
    for (const name of ['left_wrist', 'right_wrist']) {
      const pt = point(p, name);
      if (pt) out.push(pt);
    }
  }
  return out;
}

function spawn(now) {
  // 越到後面泡泡越多：一開始 0.9 秒一顆，最後 0.4 秒一顆
  const progress = 1 - Math.max(0, endAt - now) / (ROUND_SECONDS * 1000);
  nextSpawn = now + 900 - 500 * progress;
  const gold = Math.random() < GOLD_CHANCE;
  bubbles.push({
    x: 0.08 + Math.random() * 0.84, y: 1.1,
    r: gold ? 0.05 : 0.04 + Math.random() * 0.03,
    speed: 0.12 + Math.random() * 0.1 + progress * 0.08,     // 每秒往上飄多少（畫面高度）
    phase: Math.random() * Math.PI * 2, gold,
  });
}

function update(dt, now, w, h) {
  if (now >= nextSpawn) spawn(now);
  const hs = hands();
  for (const b of bubbles) {
    b.y -= b.speed * dt;
    b.x += Math.sin(now / 600 + b.phase) * 0.0006;           // 左右輕輕晃
    // 碰撞：在像素座標裡算距離（畫面不是正方形，不能直接用 0～1 算）
    const hit = hs.some((p) => Math.hypot((p.x - b.x) * w, (p.y - b.y) * h) < (b.r + HAND_RADIUS) * h);
    if (hit) {
      b.popped = true;
      score += b.gold ? 3 : 1;
      pops.push({ x: b.x, y: b.y, r: b.r, gold: b.gold, t: now });
      if (b.gold) robot.skill('gesture.wave');
      else if (score % 10 === 0) robot.say(`${score} 分了，好厲害！`);
    }
  }
  bubbles = bubbles.filter((b) => !b.popped && b.y > -0.15);
  $('score').textContent = String(score);
}

function drawBubble(ctx, b, w, h) {
  const x = b.x * w, y = b.y * h, r = b.r * h;
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  if (b.gold) {
    g.addColorStop(0, 'rgba(255, 250, 210, .95)');
    g.addColorStop(0.6, 'rgba(255, 205, 60, .75)');
    g.addColorStop(1, 'rgba(230, 150, 20, .9)');
  } else {
    g.addColorStop(0, 'rgba(255, 255, 255, .85)');
    g.addColorStop(0.55, 'rgba(140, 200, 255, .25)');
    g.addColorStop(1, 'rgba(110, 170, 255, .7)');
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
}

function drawPop(ctx, p, now, w, h) {
  const k = (now - p.t) / 350;                                 // 0～1：0.35 秒的動畫
  ctx.beginPath();
  ctx.arc(p.x * w, p.y * h, p.r * h * (1 + k * 1.2), 0, Math.PI * 2);
  ctx.strokeStyle = p.gold ? `rgba(255, 205, 60, ${1 - k})` : `rgba(180, 220, 255, ${1 - k})`;
  ctx.lineWidth = 4 * devicePixelRatio * (1 - k);
  ctx.stroke();
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  stage.draw(people, { highlight: ['left_wrist', 'right_wrist'] });
  const { ctx, canvas } = stage;
  const w = canvas.width, h = canvas.height;

  if (state === 'playing') {
    update(dt, now, w, h);
    const left = Math.max(0, endAt - now);
    $('time').style.width = `${(left / (ROUND_SECONDS * 1000)) * 100}%`;
    $('time-text').textContent = `${Math.ceil(left / 1000)} 秒`;
    if (left === 0) finish();
  } else {
    // 還沒開始：雙手舉高 2 秒就開始（剛結束的 3 秒內不算）
    const person = mainPerson(people);
    const cooling = state === 'over' && now - overAt < 3000;
    const both = !cooling && !!person && isHandUp(person, 'left') && isHandUp(person, 'right');
    if (startHold.update(both, now)) start();
    $('hold').style.width = `${startHold.progress(now) * 100}%`;
  }

  for (const b of bubbles) drawBubble(ctx, b, w, h);
  pops = pops.filter((p) => now - p.t < 350);
  for (const p of pops) drawPop(ctx, p, now, w, h);
  for (const p of hands()) {                                   // 手：黃色圓圈
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, HAND_RADIUS * h, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 211, 77, .9)';
    ctx.lineWidth = 3 * devicePixelRatio;
    ctx.stroke();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

$('start').onclick = start;

connect({
  onPose: (p, msg) => { people = p; topbar.pose(msg); },
  onHello: (msg) => topbar.hello(msg),
  onStatus: (connected) => topbar.status(connected),
  onRobot: (msg) => robotBox.show(msg),
});
