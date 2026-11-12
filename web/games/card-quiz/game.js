// 圖卡問答（長輩版）：機器人出題，長輩把圖卡拿給鏡頭看（拿穩 1.2 秒），或直接說出答案。
//
// 三種難度（照服員設定裡選，或選「自動」）：
//   Level 1 直接指認：「請拿出雞蛋」
//   Level 2 情境聯想：「早餐可以吃什麼？」→ 雞蛋或青菜都對（題目在 questions.json）
//   Level 3 複合條件：「不是吃的，但每天用來照顧身體的」（兩個條件都要符合）
//           記憶　　：先看兩張卡「牙刷、雞蛋」，藏起來後照順序拿出來
//   自動：從 Level 1 開始，連續 2 題「很快答對、沒用提示」就升一級；連續 2 題「用了提示、跳過或很久」就降一級
//
// 和學生版不一樣的地方（給長輩用要注意的事）：
//   · 不計時、不比快、不顯示「拿錯幾次」：沒有輸贏，只有「完成」
//   · 拿錯不說「錯」，而是「這是錢包，再找找看」；拿錯 2 次或 20 秒沒答對就給提示
//   · 「再說一次」按鈕、照服員設定（題數、難度、桌上放了哪些卡）、「跳過這題」
//   · 機器人說話排隊、每句至少隔 3.2 秒，接真機（cooldown 3 秒）也不會被擋
//   · 結束後列出每一題的難度、花了幾秒、有沒有用提示，給照服員參考。不存檔
//   · 語音（左下角 🎤）：說「開始」「再說一次」「跳過」「提示」，也可以直接說出答案
import { connect, createStage, mainCard, loadCards, Steady, robot } from '/common/pose.js';
import { mountTopbar, mountRobot } from '/common/ui.js';
import { voice } from '/common/voice.js';

const ANSWER_MS = 1200;      // 同一張卡拿穩多久才判斷
const BEGIN_MS = 3000;       // 還沒開始時：任何一張卡拿這麼久 = 開始
const NUDGE_MS = 20000;      // 這麼久沒有答對，就再說一次題目／給提示
const NEXT_MS = 3500;        // 答對後停一下（讓長輩聽完稱讚、把卡放下）再出下一題
const SAY_GAP_MS = 3200;     // 機器人兩句話至少隔這麼久
const FAST_S = 15;           // 自動難度：這麼快答對算「很順」
const SLOW_S = 40;           // 自動難度：超過這麼久算「有點吃力」
const PRAISE = ['答對了，好厲害！', '沒錯，就是這個！', '對了！真厲害！', '很好，答對了！', '太棒了！'];
const NUM = ['零', '一', '兩', '三', '四', '五'];   // 幾樣東西
const ORD = ['一', '二', '三', '四', '五'];         // 第幾個

const $ = (id) => document.getElementById(id);
const topbar = mountTopbar('圖卡問答');
const robotBox = mountRobot($('robot'));
const stage = createStage($('stage'));
const CARDS = await loadCards();            // cards.json 的圖卡清單
const BANK = await (await fetch('questions.json')).json();   // Level 2、3 的題庫
const byEn = new Map(CARDS.map((c) => [c.en, c]));
const byId = new Map(CARDS.map((c) => [c.id, c]));

let state = 'ready';            // ready：等開始／playing：遊戲中／over：結束
let q = null;                   // 這一題（見 makeQuestion）
let total = 5;                  // 這一輪幾題（照服員設定）
let done = 0;                   // 完成幾題（答對或跳過）
let level = 1;                  // 現在的難度
let autoLevel = true;           // 自動調整難度
let streakGood = 0, streakHard = 0;     // 自動難度用：連續幾題很順／有點吃力
let lastKey = null;             // 上一題的題目（不要連續出同一題）
let usedKeys = new Set();       // 這一輪出過的題目（題目夠多就不重複）
let memoryTurn = false;         // Level 3 輪流出複合條件和記憶題
let askedAt = 0, lastNudgeAt = 0, nudges = 0, wrongThis = 0, hinted = false;
let overAt = 0;
let waitUntil = 0;              // 這段時間不判斷（答對後停一下、記憶題正在給長輩看）
let holding = null;             // 現在鏡頭看到的卡（id）
let records = [];               // 每一題的紀錄
const answer = new Steady(ANSWER_MS);
const begin = new Steady(BEGIN_MS);

// ---------------------------------------------------------------- 照服員設定：桌上有哪些卡、難度

let deck = new Set(CARDS.map((c) => c.id));
try {
  const saved = JSON.parse(localStorage.getItem('card-quiz-deck'));
  const kept = Array.isArray(saved) ? saved.filter((id) => byId.has(id)) : [];
  if (kept.length) deck = new Set(kept);      // cards.json 換過、存的卡都不在了：就用全部的卡
} catch {}
try { $('level').value = localStorage.getItem('card-quiz-level') || 'auto'; } catch {}
$('level').onchange = () => { try { localStorage.setItem('card-quiz-level', $('level').value); } catch {} };

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
 * tag：同一種話只留最新的一句。例如「這是錢包」還沒說出來，長輩已經換成牙刷，就只說「這是牙刷」
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
/** 現在排隊的話大概還要多久才說完（記憶題要等說完才開始計時） */
function talkDoneIn() {
  return Math.max(0, lastSayAt + SAY_GAP_MS - performance.now()) + sayQueue.length * SAY_GAP_MS;
}

// ---------------------------------------------------------------- 出題

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const onTable = () => CARDS.filter((c) => deck.has(c.id));

/**
 * 做一題。回傳：
 *   { kind: 'pick', level, key, ask, short, answers: Set(id), hint, show: {pic, task, long} }   ← Level 1、2、3 複合條件
 *   { kind: 'memory', level: 3, key, seq: [id...], step, phase: 'look'|'recall', short }      ← Level 3 記憶
 * 題目的答案不在桌上（照服員沒勾）就不出；這一級沒有題目可出，就往下一級找
 */
function makeQuestion(lv) {
  const table = onTable();
  if (lv >= 3) {
    const n = Math.min(BANK.memory?.items || 2, table.length);
    memoryTurn = !memoryTurn;
    if (memoryTurn && n >= 2) {
      const seq = [...table].sort(() => Math.random() - 0.5).slice(0, n).map((c) => c.id);
      return { kind: 'memory', level: 3, key: 'mem:' + seq.join(','), seq, step: 0, phase: 'look',
        short: '記住 ' + seq.map((id) => byId.get(id).name).join('→') };
    }
  }
  if (lv >= 2) {
    const list = (lv >= 3 ? BANK.level3 : BANK.level2) || [];
    const ok = list
      .map((x) => ({ ...x, ids: x.answers.map((en) => byEn.get(en)?.id).filter((id) => deck.has(id)) }))
      .filter((x) => x.ids.length && x.short !== lastKey);
    if (ok.length) {
      const fresh = ok.filter((x) => !usedKeys.has(x.short));
      const x = pick(fresh.length ? fresh : ok);
      return { kind: 'pick', level: lv, key: x.short, ask: x.ask, short: x.short, answers: new Set(x.ids),
        hint: x.hint || null, show: { pic: '🤔', task: x.ask, long: true } };
    }
    return makeQuestion(lv - 1);
  }
  const choices = table.length > 1 ? table.filter((c) => c.name !== lastKey) : table;
  const fresh = choices.filter((c) => !usedKeys.has(c.name));
  const c = pick(fresh.length ? fresh : choices);
  return { kind: 'pick', level: 1, key: c.name, ask: `請拿出${c.name}`, short: c.name, answers: new Set([c.id]),
    hint: c.hint ? `${c.name}是${c.hint}` : null, show: { pic: c.emoji, task: c.name, long: false } };
}

function ask() {
  q = makeQuestion(level);
  lastKey = q.key;
  usedKeys.add(q.key);
  askedAt = lastNudgeAt = performance.now();
  nudges = 0; wrongThis = 0; hinted = false;
  $('task-card').classList.remove('hinting', 'long', 'memory');
  $('progress').textContent = `第 ${done + 1} 題／共 ${total} 題　難度 ${q.level}${autoLevel ? '（自動）' : ''}`;
  $('clue').textContent = '';
  answer.ignore(holding);       // 還拿著上一題的卡不算，要先拿開

  if (q.kind === 'memory') {
    const names = q.seq.map((id) => byId.get(id).name);
    $('task-card').classList.add('memory');
    $('pic').textContent = q.seq.map((id) => byId.get(id).emoji).join(' ');
    $('task').textContent = '請記住';
    $('clue').textContent = names.join('、');
    talk(`我們來考考記性。請記住這${NUM[names.length]}樣東西：${names.join('、')}。`, `請記住：${names.join('、')}`);
    // 說完之後再給長輩看 show_seconds 秒，然後藏起來
    const lookMs = talkDoneIn() + (BANK.memory?.show_seconds || 6) * 1000;
    waitUntil = performance.now() + lookMs + 1000;
    const thisQ = q;
    setTimeout(() => { if (q === thisQ && state === 'playing') startRecall(); }, lookMs);
    return;
  }
  $('pic').textContent = q.show.pic;
  $('task').textContent = q.show.task;
  if (q.show.long) $('task-card').classList.add('long');
  talk(q.ask, q.level === 1 ? `${q.show.pic} ${q.show.task}` : q.ask);
}

/** 記憶題：藏起來，請長輩照順序拿出來 */
function startRecall() {
  q.phase = 'recall';
  askedAt = lastNudgeAt = performance.now();
  renderSlots();
  $('task').textContent = '照順序拿出來';
  $('clue').textContent = '';
  answer.ignore(holding);
  talk(`好，藏起來了。剛剛的${NUM[q.seq.length]}樣東西，請照順序拿給我。`, '照順序拿出來');
}

function renderSlots() {
  $('pic').textContent = q.seq.map((id, i) => (i < q.step ? byId.get(id).emoji : '❓')).join(' ');
}

function questionAgain() {
  if (q.kind === 'memory') {
    return q.phase === 'look' ? null : `請照順序，拿出剛剛記住的${NUM[q.seq.length]}樣東西。現在要第${ORD[q.step]}個。`;
  }
  return q.ask;
}

function giveHint() {
  hinted = true;
  $('task-card').classList.add('hinting');
  if (q.kind === 'memory') {
    const c = byId.get(q.seq[q.step]);
    $('clue').textContent = `提示：下一個是 ${c.emoji} ${c.name}`;
    talk(`給你一個提示，下一個是${c.name}。`);
    return;
  }
  if (q.hint) {
    $('clue').textContent = `提示：${q.hint}`;
    talk(`給你一個提示，${q.hint}`);
  } else {                                    // 題庫沒寫提示：給看其中一個答案的圖案
    const c = byId.get([...q.answers][0]);
    $('clue').textContent = `提示：看看這個圖案 ${c.emoji}`;
    talk('給你一個提示，看看畫面上的圖案。');
  }
}

// ---------------------------------------------------------------- 一輪的開始和結束

function start() {
  if (deck.size === 0) {
    $('task').textContent = '請先在「照服員設定」勾選桌上的圖卡';
    $('setup').open = true;
    return;
  }
  clearTalk();
  state = 'playing';
  total = Number($('count').value) || 5;
  autoLevel = $('level').value === 'auto';
  level = autoLevel ? 1 : Number($('level').value);
  streakGood = streakHard = 0;
  done = 0;
  records = [];
  waitUntil = 0;
  q = null;
  lastKey = null;
  usedKeys = new Set();
  $('summary').hidden = true;
  $('start').disabled = true;
  $('start').textContent = '開始';
  $('repeat').disabled = false;
  $('skip').disabled = false;
  robot.expression('happy');
  talk('我們來玩圖卡遊戲，我說什麼，就把那張卡拿給我看，用說的也可以。');
  ask();
}

/** 一題結束（答對或跳過）：記錄、調整難度、出下一題 */
function next(now, rec) {
  records.push(rec);
  adapt(rec);
  done += 1;
  const last = done >= total;
  waitUntil = now + (last ? 2000 : NEXT_MS);     // 最後一題：先讓「答對了」顯示 2 秒再結束
  setTimeout(() => { if (state === 'playing') (last ? finish : ask)(); }, last ? 2000 : NEXT_MS);
}

/** 自動難度：連續 2 題很順就升級，連續 2 題吃力就降級 */
function adapt(rec) {
  if (!autoLevel) return;
  const good = !rec.skipped && !rec.hinted && rec.seconds <= FAST_S && rec.wrong === 0;
  const hard = rec.skipped || rec.hinted || rec.seconds > SLOW_S;
  streakGood = good ? streakGood + 1 : 0;
  streakHard = hard ? streakHard + 1 : 0;
  if (streakGood >= 2 && level < 3) { level += 1; streakGood = 0; }
  if (streakHard >= 2 && level > 1) { level -= 1; streakHard = 0; }
}

function finish() {
  state = 'over';
  overAt = performance.now();
  q = null;
  $('start').disabled = false;
  $('start').textContent = '再玩一次';
  $('repeat').disabled = true;
  $('skip').disabled = true;
  $('task-card').classList.remove('hinting', 'long', 'memory');
  $('progress').textContent = '完成了';
  $('pic').textContent = '🌟';
  $('task').textContent = '完成！';
  $('clue').textContent = '按「再玩一次」，或拿任何一張圖卡 3 秒';
  showBig('完成！', 'good', 3000);
  showSummary();
  robot.expression('proud');
  const answered = records.filter((r) => !r.skipped).length;
  talk(`全部完成了！你答對了 ${answered} 題，真的很棒，謝謝你陪我玩！`, '全部完成 🌟');
  setTimeout(() => robot.nod(), 1500);
}

function showSummary() {
  $('results').innerHTML = '';
  for (const r of records) {
    const li = document.createElement('li');
    const tags = [r.hinted && '用了提示', r.how === 'voice' && '用說的'].filter(Boolean);
    li.textContent = `難度 ${r.level}｜${r.short}：` +
      (r.skipped ? '跳過' : `${r.seconds.toFixed(0)} 秒${tags.length ? `（${tags.join('、')}）` : ''}`);
    if (r.skipped) li.className = 'skipped';
    $('results').append(li);
  }
  if (autoLevel) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = `下一輪建議從難度 ${level} 開始`;
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

// ---------------------------------------------------------------- 每張畫面

function onPose(people, msg) {
  topbar.pose(msg);
  const card = mainCard(msg.cards);          // 最靠近鏡頭的那張卡
  // 只有 Level 1 才把正確的卡畫綠框（Level 2、3 畫綠框等於直接告訴答案）
  const good = q?.kind === 'pick' && q.level === 1 ? [...q.answers][0] : undefined;
  stage.draw(people, { skeleton: false, cards: msg.cards, goodCard: good });
  $('seen').textContent = card ? `${card.emoji} ${card.name}` : '（沒有看到圖卡）';
  holding = card?.id ?? null;
  const now = performance.now();

  if (state !== 'playing') {
    const cooling = state === 'over' && now - overAt < 5000;   // 剛結束 5 秒內不算（長輩可能還拿著卡）
    if (begin.update(cooling ? null : card?.id) !== null) start();
    $('hold').style.width = `${begin.progress() * 100}%`;
    return;
  }
  if (now < waitUntil || !q) { $('hold').style.width = '0%'; return; }

  // 很久沒答對：先再說一次題目，再久一點就給提示
  if (now - lastNudgeAt > NUDGE_MS) {
    lastNudgeAt = now;
    nudges += 1;
    if (nudges === 1 || hinted) talk(`慢慢來。${questionAgain()}`);
    else giveHint();
  }

  const id = answer.update(holding);
  $('hold').style.width = `${answer.progress() * 100}%`;
  if (id !== null) judge(id, now, 'card');
}

/** 判斷答案。how：'card'（拿卡）或 'voice'（用說的） */
function judge(id, now, how) {
  lastNudgeAt = now;                          // 有拿卡或有回答就算有在玩，重新計算提醒時間
  const shown = byId.get(id);
  if (q.kind === 'memory') return judgeMemory(id, now, how, shown);

  if (q.answers.has(id)) {
    correct(now, how, `${shown.emoji} `);
    return;
  }
  wrongThis += 1;
  const what = how === 'voice' ? `你說的是${shown.name}` : `這是${shown.name}`;
  showBig(how === 'voice' ? `「${shown.name}」` : `這是${shown.name}`, 'soft', 1800);
  const again = q.level === 1 ? `我們要找的是${[...q.answers].map((i) => byId.get(i).name)[0]}` : '好像不太對';
  // 第一、二次說完整一點；之後說短一點，不要一直重複長句子
  talk(wrongThis <= 2 ? `${what}，${again}，再想想看。` : `${what}，再找找看。`, null, 'wrong');
  if (wrongThis === 2 && q.level > 1) talk(q.ask);              // Level 2、3 拿錯兩次：把題目再說一次
  if (wrongThis >= 2 && !hinted) giveHint();
}

function judgeMemory(id, now, how, shown) {
  if (q.phase !== 'recall') return;
  if (id === q.seq[q.step]) {
    q.step += 1;
    renderSlots();
    $('clue').textContent = '';
    $('task-card').classList.remove('hinting');
    answer.ignore(holding);                   // 要換下一張卡才算
    if (q.step >= q.seq.length) { correct(now, how, ''); return; }
    talk(`對，第${ORD[q.step - 1]}個是${shown.name}。下一個呢？`, null, 'wrong');
    return;
  }
  wrongThis += 1;
  const later = q.seq.indexOf(id);
  showBig(how === 'voice' ? `「${shown.name}」` : `這是${shown.name}`, 'soft', 1800);
  if (later > q.step) talk(`有${shown.name}沒錯，但是順序不太對喔，它是後面的。前面還有一個，是什麼呢？`, null, 'wrong');
  else if (later >= 0) talk(`${shown.name}已經拿過了，下一個呢？`, null, 'wrong');
  else talk(`${shown.name}剛剛沒有出現喔，再想想看。`, null, 'wrong');
  if (wrongThis >= 2 && !hinted) giveHint();
}

function correct(now, how, emoji) {
  const rec = { level: q.level, short: q.short, seconds: (now - askedAt) / 1000, hinted, skipped: false,
    how, wrong: wrongThis };
  $('task-card').classList.remove('flash');
  void $('task-card').offsetWidth;
  $('task-card').classList.add('flash');
  showBig('答對了！', 'good', 2000);
  const praise = q.kind === 'memory' ? '全部都記得，記性真好！' : PRAISE[Math.floor(Math.random() * PRAISE.length)];
  clearTalk();
  talk(praise, `${emoji}${praise}`);
  robot.nod();
  next(now, rec);
}

$('start').onclick = start;
$('repeat').onclick = () => {
  if (state !== 'playing' || !q) return;
  const text = questionAgain();
  if (!text) return;                          // 記憶題正在給長輩看，不用重說
  clearTalk();
  talk(text, q.kind === 'pick' && q.level === 1 ? `${q.show.pic} ${q.show.task}` : null);
  if (hinted && q.kind === 'pick' && q.hint) talk(`提示：${q.hint}`);
};
$('skip').onclick = () => {
  if (state !== 'playing' || !q || performance.now() < waitUntil) return;
  clearTalk();
  talk('沒關係，我們換下一題。');
  next(performance.now(), { level: q.level, short: q.short, seconds: 0, hinted, skipped: true, wrong: wrongThis });
};

// ---------------------------------------------------------------- 語音

voice.words(CARDS.map((c) => c.name));        // 告訴語音辨識：可能會聽到這些卡片名稱
voice.command(['提示', '給我提示', '不知道', '想不起來', 'hint'], () => {
  if (state !== 'playing' || !q || hinted || performance.now() < waitUntil) return false;
  giveHint();
});
// 直接說出答案：句子裡有卡片的名稱（中文或英文）就當作回答。記憶題可以一次說好幾個（照說的順序）
voice.onText((text) => {
  if (state !== 'playing' || !q || performance.now() < waitUntil) return false;
  const t = text.toLowerCase();
  const said = onTable()
    .map((c) => ({ c, at: Math.min(...[text.indexOf(c.name), c.en ? t.indexOf(c.en) : -1].filter((i) => i >= 0), Infinity) }))
    .filter((x) => x.at !== Infinity)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.c);
  if (!said.length) return false;
  if (q.kind === 'memory') {
    for (const c of said) { if (q?.kind !== 'memory' || q.phase !== 'recall') break; judge(c.id, performance.now(), 'voice'); }
    return true;
  }
  if (said.length !== 1) return false;        // 一次說了好幾張：不算
  judge(said[0].id, performance.now(), 'voice');
  return true;
});

connect({
  onPose,
  onHello: (msg) => topbar.hello(msg),
  onStatus: (connected) => topbar.status(connected),
  onRobot: (msg) => robotBox.show(msg),
});
