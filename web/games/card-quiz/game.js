// 圖卡問答（長輩版）：機器人說「請拿出牙刷」，長輩把牙刷的圖卡拿給鏡頭看，拿穩 1.2 秒就判斷。
//
// 和原本學生版不一樣的地方（給長輩用要注意的事）：
//   · 不計時、不比快、不顯示「拿錯幾次」：沒有輸贏，只有「完成」
//   · 拿穩的時間從 0.6 秒加長到 1.2 秒：長輩的手比較會晃，也需要時間對準
//   · 拿錯不說「錯」，而是「這是錢包，我們要找的是牙刷，再找找看」；拿錯 2 次就給提示（cards.json 的 hint）
//   · 20 秒沒有動作：先把題目再說一次；再 20 秒：給提示。照服員也可以按「跳過這題」
//   · 「再說一次」按鈕：長輩忘記題目時可以重聽
//   · 照服員設定：題數、桌上放了哪些卡（只從這些卡出題，例如一開始只放 3 張，比較簡單）
//   · 機器人說話排隊、每句至少隔 3.2 秒，接真機（cooldown 3 秒）也不會被擋
//   · 結束後列出每一題花了幾秒、有沒有用到提示，給照服員參考。不存檔
//   · 語音（左下角 🎤）：說「開始」「再說一次」「跳過」「提示」；拿不動卡的長輩也可以直接說出答案（「雞蛋」）
import { connect, createStage, mainCard, loadCards, Steady, robot } from '/common/pose.js';
import { mountTopbar, mountRobot } from '/common/ui.js';
import { voice } from '/common/voice.js';

const ANSWER_MS = 1200;      // 同一張卡拿穩多久才判斷
const BEGIN_MS = 3000;       // 還沒開始時：任何一張卡拿這麼久 = 開始
const NUDGE_MS = 20000;      // 這麼久沒有答對，就再說一次題目／給提示
const NEXT_MS = 3500;        // 答對後停一下（讓長輩聽完稱讚、把卡放下）再出下一題
const SAY_GAP_MS = 3200;     // 機器人兩句話至少隔這麼久
const PRAISE = ['答對了，好厲害！', '沒錯，就是這張！', '對了！眼睛真利！', '很好，答對了！', '太棒了！'];

const $ = (id) => document.getElementById(id);
const topbar = mountTopbar('圖卡問答');
const robotBox = mountRobot($('robot'));
const stage = createStage($('stage'));
const CARDS = await loadCards();            // cards.json 的圖卡清單

let state = 'ready';            // ready：等開始／playing：遊戲中／over：結束
let target = null;              // 這一題要的卡
let total = 5;                  // 這一輪幾題（照服員設定）
let done = 0;                   // 完成幾題（答對或跳過）
let askedAt = 0;                // 這一題出題的時間
let lastNudgeAt = 0;            // 上一次提醒的時間
let nudges = 0;                 // 這一題提醒過幾次
let wrongThis = 0;              // 這一題拿錯幾次
let hinted = false;             // 這一題給過提示了嗎
let overAt = 0;
let waitUntil = 0;              // 答對後停一下，這段時間不判斷
let holding = null;             // 現在鏡頭看到的卡（id）
let records = [];               // 每一題的紀錄：{card, seconds, hinted, skipped, how}
const answer = new Steady(ANSWER_MS);
const begin = new Steady(BEGIN_MS);

// ---------------------------------------------------------------- 照服員設定：桌上有哪些卡

let deck = new Set(CARDS.map((c) => c.id));
try {
  const saved = JSON.parse(localStorage.getItem('card-quiz-deck'));
  const kept = Array.isArray(saved) ? saved.filter((id) => CARDS.some((c) => c.id === id)) : [];
  if (kept.length) deck = new Set(kept);      // cards.json 換過、存的卡都不在了：就用全部的卡
} catch {}

function renderDeck() {
  $('deck').innerHTML = '';
  for (const c of CARDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${c.emoji} ${c.name}`;
    b.className = deck.has(c.id) ? '' : 'off';
    b.onclick = () => {
      if (deck.has(c.id)) deck.delete(c.id); else deck.add(c.id);
      try { localStorage.setItem('card-quiz-deck', JSON.stringify([...deck])); } catch {}
      renderDeck();
    };
    $('deck').append(b);
  }
}
renderDeck();

// ---------------------------------------------------------------- 說話

const sayQueue = [];
let lastSayAt = -Infinity;
let sayTimer = null;
/**
 * 說一句話（同時在機器人螢幕上顯示 show）。排隊送，每句至少隔 SAY_GAP_MS。
 * tag：同一種話只留最新的一句。例如「這是狗」還沒說出來，長輩已經換成魚，就只說「這是魚」，不說過時的話
 */
function talk(text, show = null, tag = null) {
  if (tag) for (let i = sayQueue.length - 1; i >= 0; i--) if (sayQueue[i].tag === tag) sayQueue.splice(i, 1);
  sayQueue.push({ text, show, tag });
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
    if (show) robot.show(show);              // 唸出來的部分由 ui.js 處理（模擬機器人時用電腦喇叭）
    pumpSay();
  }, wait);
}
function clearTalk() {
  sayQueue.length = 0;
  clearTimeout(sayTimer);
  sayTimer = null;
}

// ---------------------------------------------------------------- 遊戲流程

function questionText() {
  return `請拿出${target.name}`;
}

function ask() {
  const pool = CARDS.filter((c) => deck.has(c.id));
  const choices = pool.length > 1 ? pool.filter((c) => c !== target) : pool;
  target = choices[Math.floor(Math.random() * choices.length)];
  askedAt = lastNudgeAt = performance.now();
  nudges = 0;
  wrongThis = 0;
  hinted = false;
  $('task-card').classList.remove('hinting');
  $('progress').textContent = `第 ${done + 1} 題／共 ${total} 題`;
  $('pic').textContent = target.emoji;
  $('task').textContent = target.name;
  $('clue').textContent = '';
  answer.ignore(holding);       // 還拿著上一題的卡不算，要先拿開
  talk(questionText(), `${target.emoji} ${target.name}`);
}

function giveHint() {
  hinted = true;
  $('task-card').classList.add('hinting');
  const clue = target.hint || `圖案是這樣的：${target.emoji}`;
  $('clue').textContent = `提示：${clue}`;
  talk(target.hint ? `給你一個提示，${target.name}是${target.hint}。` : '給你一個提示，看看畫面上的圖案。');
}

function start() {
  if (deck.size === 0) {
    $('task').textContent = '請先在「照服員設定」勾選桌上的圖卡';
    $('setup').open = true;
    return;
  }
  clearTalk();
  state = 'playing';
  total = Number($('count').value) || 5;
  done = 0;
  records = [];
  waitUntil = 0;
  target = null;
  $('summary').hidden = true;
  $('start').disabled = true;
  $('start').textContent = '開始';
  $('repeat').disabled = false;
  $('skip').disabled = false;
  robot.expression('happy');
  talk('我們來玩圖卡遊戲，我說什麼，就把那張卡拿給我看。');
  ask();
}

function next(now) {
  done += 1;
  const last = done >= total;
  waitUntil = now + (last ? 2000 : NEXT_MS);     // 最後一題：先讓「答對了」顯示 2 秒再結束
  setTimeout(() => { if (state === 'playing') (last ? finish : ask)(); }, last ? 2000 : NEXT_MS);
}

function finish() {
  state = 'over';
  overAt = performance.now();
  target = null;
  $('start').disabled = false;
  $('start').textContent = '再玩一次';
  $('repeat').disabled = true;
  $('skip').disabled = true;
  $('task-card').classList.remove('hinting');
  $('progress').textContent = '完成了';
  $('pic').textContent = '🌟';
  $('task').textContent = '完成！';
  $('clue').textContent = '按「再玩一次」，或拿任何一張圖卡 3 秒';
  showBig('完成！', 'good', 3000);
  showSummary();
  robot.expression('proud');
  const answered = records.filter((r) => !r.skipped).length;
  talk(`全部完成了！你找到了 ${answered} 張卡，真的很棒，謝謝你陪我玩！`, '全部完成 🌟');
  setTimeout(() => robot.nod(), 1500);
}

function showSummary() {
  $('results').innerHTML = '';
  for (const r of records) {
    const li = document.createElement('li');
    li.textContent = r.skipped
      ? `${r.card.emoji} ${r.card.name}：跳過`
      : `${r.card.emoji} ${r.card.name}：${r.seconds.toFixed(0)} 秒${r.hinted ? '（用了提示）' : ''}${r.how === 'voice' ? '（用說的）' : ''}`;
    if (r.skipped) li.className = 'skipped';
    $('results').append(li);
  }
  $('summary').hidden = false;
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
    const cooling = state === 'over' && now - overAt < 5000;   // 剛結束 5 秒內不算（長輩可能還拿著卡）
    if (begin.update(cooling ? null : card?.id) !== null) start();
    $('hold').style.width = `${begin.progress() * 100}%`;
    return;
  }
  if (now < waitUntil) { $('hold').style.width = '0%'; return; }

  // 很久沒答對：先再說一次題目，再久一點就給提示
  if (now - lastNudgeAt > NUDGE_MS) {
    lastNudgeAt = now;
    nudges += 1;
    if (nudges === 1 || hinted) talk(`慢慢來，我們要找的是${target.name}。`);
    else giveHint();
  }

  const id = answer.update(holding);
  $('hold').style.width = `${answer.progress() * 100}%`;
  if (id !== null) judge(id, now, 'card');
}

/** 判斷答案。how：'card'（拿卡）或 'voice'（用說的） */
function judge(id, now, how) {
  lastNudgeAt = now;                          // 有拿卡或有回答就算有在玩，重新計算提醒時間

  if (id === target.id) {
    records.push({ card: target, seconds: (now - askedAt) / 1000, hinted, skipped: false, how });
    $('task-card').classList.remove('flash');
    void $('task-card').offsetWidth;
    $('task-card').classList.add('flash');
    showBig('答對了！', 'good', 2000);
    const praise = PRAISE[Math.floor(Math.random() * PRAISE.length)];
    clearTalk();
    talk(praise, `${target.emoji} ${praise}`);
    robot.nod();
    next(now);
  } else {
    wrongThis += 1;
    const shown = CARDS.find((c) => c.id === id);
    const what = how === 'voice' ? `你說的是${shown.name}` : `這是${shown.name}`;
    showBig(how === 'voice' ? `「${shown.name}」` : `這是${shown.name}`, 'soft', 1800);
    // 第一、二次說完整一點；之後說短一點，不要一直重複長句子
    talk(wrongThis <= 2 ? `${what}。我們要找的是${target.name}，再找找看。` : `${what}，再找找看。`, null, 'wrong');
    if (wrongThis >= 2 && !hinted) giveHint();
  }
}

$('start').onclick = start;
$('repeat').onclick = () => {
  if (state !== 'playing' || !target) return;
  clearTalk();
  talk(questionText(), `${target.emoji} ${target.name}`);
  if (hinted) talk(`提示：${target.hint || target.emoji}`);
};
$('skip').onclick = () => {
  if (state !== 'playing' || !target || performance.now() < waitUntil) return;
  records.push({ card: target, seconds: 0, hinted, skipped: true });
  clearTalk();
  talk('沒關係，我們換下一張。');
  next(performance.now());
};

// ---------------------------------------------------------------- 語音

voice.words(CARDS.map((c) => c.name));        // 告訴語音辨識：可能會聽到這些卡片名稱
voice.command(['提示', '給我提示', '不知道', 'hint'], () => {
  if (state !== 'playing' || !target || hinted) return false;
  giveHint();
});
// 直接說出答案：句子裡有某張卡的名稱（中文或英文）就當作回答
voice.onText((text) => {
  if (state !== 'playing' || !target || performance.now() < waitUntil) return false;
  const t = text.toLowerCase();
  const said = CARDS.filter((c) => deck.has(c.id) && (text.includes(c.name) || (c.en && t.includes(c.en))));
  if (said.length !== 1) return false;        // 沒說到、或一次說了好幾張：不算
  judge(said[0].id, performance.now(), 'voice');
  return true;
});

connect({
  onPose,
  onHello: (msg) => topbar.hello(msg),
  onStatus: (connected) => topbar.status(connected),
  onRobot: (msg) => robotBox.show(msg),
});
