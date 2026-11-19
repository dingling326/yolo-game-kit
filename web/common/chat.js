// chat.js：機器人「小寶」，跟著網頁一起啟動，每一頁都有（ui.js 的 mountTopbar 和大廳會呼叫 mountChat），遊戲不用改。
//
//   · 不用另外按按鈕：網頁一打開就開始聽（瀏覽器規定要先點過畫面時，點畫面任何地方就開始）
//   · 長輩說的話先給這一頁（遊戲的指令、大廳的遊戲名稱、圖卡問答的答案）；這一頁不處理的話，就是在跟小寶聊天
//   · 指令要整句話就是指令才算（「我年輕時開始學做菜」不會按到「開始」）
//   · 右下角小寶的小視窗：顯示他說的話；點一下展開對話紀錄、換個話題、照服員設定
//   · 「小寶安靜一下」就不回話；說「小寶」再叫醒他
//   · 換頁接著聊（存在這個分頁的 sessionStorage，關掉瀏覽器就沒了，不會存檔）；小寶知道長輩在哪一頁
//   · 只有在大廳，長輩一陣子沒說話時小寶才會主動問一句（玩遊戲時不打擾）
//   · 長輩提到身體不舒服、跌倒、不想活了：畫面最上面出現「請照服員注意」（只給照服員看）
//
// 伺服器：POST /api/chat（pose_service/chat.py，用 Claude）。聲音在這台電腦辨識，只有文字會送出去。
import { robot } from './pose.js';
import { voice } from './voice.js';

const SILENCE_MS = 60000;    // 在大廳，長輩這麼久沒說話，小寶就問一句
const MAX_NUDGES = 2;        // 每次進大廳最多主動問幾次
const SAY_GAP_MS = 1000;     // 一句一句說（機器人同一個動作 0.8 秒內只能叫一次）
const MAX_LOG = 10;
const STORE = 'chat-session';
const TOPICS = ['家鄉', '年輕時候的工作', '最拿手的一道菜', '喜歡的老歌', '小時候玩的遊戲', '過年過節的回憶',
  '家裡的人', '今天的天氣', '最近吃到的好吃東西', '以前住的房子', '第一次出遠門', '喜歡的花或植物'];

const st = {
  page: '', lobby: false, busy: false, history: [], log: [], pending: [], lastReply: '', muted: false, greeted: false,
  lastActivity: 0, nudges: 0, speakingUntil: 0, lastTopic: null, ui: null,
};

// ---------------------------------------------------------------- 存這個分頁的對話（換頁接著聊）

function save() {
  try {
    sessionStorage.setItem(STORE, JSON.stringify({ history: st.history.slice(-30), log: st.log, lastReply: st.lastReply,
      muted: st.muted, greeted: st.greeted }));
  } catch {}
}
function restore() {
  try {
    const s = JSON.parse(sessionStorage.getItem(STORE));
    if (s) Object.assign(st, { history: s.history || [], log: s.log || [], lastReply: s.lastReply || '', muted: !!s.muted, greeted: !!s.greeted });
  } catch {}
}
const elderName = () => { try { return localStorage.getItem('chat-name') || ''; } catch { return ''; } };

// ---------------------------------------------------------------- 畫面

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function buildUi() {
  const panel = el('section', 'chat-panel');
  panel.setAttribute('aria-label', '小寶');
  panel.innerHTML = `
    <button type="button" class="chat-head" aria-expanded="false">
      <span class="chat-face"><i></i><i></i><b></b></span>
      <span class="chat-status">小寶</span><span class="chat-toggle">展開</span>
    </button>
    <div class="chat-say"></div>
    <div class="chat-body">
      <div class="chat-log"></div>
      <div class="chat-actions">
        <button type="button" class="chat-topic">換個話題</button><button type="button" class="chat-again">再說一次</button>
        <button type="button" class="chat-mute">小寶安靜</button>
      </div>
      <details class="chat-more"><summary>照服員設定</summary>
        <label>怎麼稱呼長輩（例如：張爺爺）<input class="chat-name" type="text" maxlength="20" placeholder="不填就不稱呼名字"></label>
        <label>用打字的<span class="chat-type"><input class="chat-text" type="text" maxlength="200" placeholder="打字後按送出"><button type="button" class="chat-send">送出</button></span></label>
        <p class="chat-note">聲音在這台電腦辨識，只有文字會送到 Claude（Anthropic）產生回答，不會存檔。說「小寶安靜一下」小寶就不回話，說「小寶」再叫醒他。</p>
        <p class="chat-error" hidden></p>
        <button type="button" class="chat-clear">清除這次的對話</button>
      </details>
    </div>`;

  const alert = el('div', 'chat-alert');
  alert.hidden = true;
  alert.innerHTML = '<div><b>請照服員注意</b><span class="chat-alert-text"></span></div><button type="button">知道了</button>';

  document.body.append(panel, alert);
  const $ = (sel) => panel.querySelector(sel);
  const name = $('.chat-name');
  name.value = elderName();
  name.onchange = () => { try { localStorage.setItem('chat-name', name.value.trim()); } catch {} };
  $('.chat-head').onclick = () => {
    const open = panel.classList.toggle('expanded');
    $('.chat-head').setAttribute('aria-expanded', String(open));
    $('.chat-toggle').textContent = open ? '收起' : '展開';
    if (open) renderLog();
  };
  $('.chat-topic').onclick = () => changeTopic();
  $('.chat-again').onclick = () => { if (st.lastReply) speak(st.lastReply); };
  $('.chat-mute').onclick = () => setMuted(!st.muted, true);
  $('.chat-send').onclick = () => {
    const t = $('.chat-text').value.trim();
    if (!t) return;
    $('.chat-text').value = '';
    if (st.muted) setMuted(false);
    ask(t);
  };
  $('.chat-text').onkeydown = (e) => { if (e.key === 'Enter') $('.chat-send').click(); };
  $('.chat-clear').onclick = () => { st.history = []; st.log = []; st.lastReply = ''; renderLog(); save(); greet(); };
  alert.querySelector('button').onclick = () => { alert.hidden = true; };
  return { panel, alert, $ };
}

function setMode(mode, status) {
  st.ui.panel.dataset.mode = mode;          // listening／thinking／speaking／muted：小寶的臉跟著變
  if (status !== undefined) st.ui.$('.chat-status').textContent = status;
}
const idleStatus = () => (st.muted ? '小寶安靜中（說「小寶」叫我）' : '小寶在聽，想聊什麼都可以說');

function addLog(kind, text) {
  st.log.push({ kind, text });
  st.log = st.log.slice(-MAX_LOG);
  renderLog();
  save();
}
function renderLog() {
  const box = st.ui.$('.chat-log');
  box.replaceChildren(...st.log.map((m) => el('div', `chat-msg ${m.kind}`, m.text)));
  box.scrollTop = box.scrollHeight;
}

function showError(text) {
  const e = st.ui.$('.chat-error');
  e.textContent = text;
  e.hidden = !text;
  if (text) { st.ui.panel.classList.add('expanded'); st.ui.$('.chat-more').open = true; }
}

function setMuted(on, announce = false) {
  st.muted = on;
  st.ui.$('.chat-mute').textContent = on ? '叫醒小寶' : '小寶安靜';
  setMode(on ? 'muted' : 'listening', idleStatus());
  if (announce) speak(on ? '好，我先安靜，要聊天再叫我「小寶」喔。' : '我在這裡，想聊什麼都可以跟我說。');
  save();
}

// ---------------------------------------------------------------- 說話

const sayQueue = [];
let sayTimer = null;
let lastSayAt = -Infinity;
function speak(text) {
  st.ui.$('.chat-say').textContent = text;
  const parts = text.match(/[^。！？!?]+[。！？!?]?/g) || [text];
  let chunk = '';
  for (const s of parts) {                  // 機器人一次最多說 100 個字：切成一句一句
    if ((chunk + s).length > 90 && chunk) { sayQueue.push(chunk); chunk = ''; }
    chunk += s;
  }
  if (chunk) sayQueue.push(chunk);
  const zh = (text.match(/[一-鿿]/g) || []).length;
  st.speakingUntil = performance.now() + 800 + zh * 300 + sayQueue.length * SAY_GAP_MS;
  setMode('speaking', '小寶');
  pumpSay();
}
function pumpSay() {
  if (sayTimer || !sayQueue.length) return;
  const wait = Math.max(0, lastSayAt + SAY_GAP_MS - performance.now());
  sayTimer = setTimeout(() => {
    sayTimer = null;
    lastSayAt = performance.now();
    robot.say(sayQueue.shift());            // 唸出來：遊戲頁由 ui.js、大廳由 index.html 處理
    pumpSay();
  }, wait);
}

// ---------------------------------------------------------------- 問 Claude

async function ask(text, { hidden = false, logged = false } = {}) {
  text = text.trim();
  if (!text) return;
  if (st.busy) { if (!hidden) { st.pending.push(text); addLog('user', text); } return; }
  st.busy = true;
  if (!hidden) st.nudges = 0;
  if (!hidden && !logged) addLog('user', text);
  st.history.push({ role: 'user', content: text });
  st.lastActivity = performance.now();
  setMode('thinking', '小寶想一想…');
  robot.expression('expecting');
  let out;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: st.history, name: elderName(), page: st.page }),
    });
    out = await res.json();
  } catch {
    out = { ok: false, error: '連不到辨識服務' };
  }
  st.busy = false;
  if (!out.ok) {
    st.history.pop();                       // 沒得到回答：從紀錄拿掉，下次重新送
    showError(`聊天出問題：${out.error}`);
    addLog('note', '（小寶沒有回答，請照服員看「照服員設定」）');
    speak('不好意思，我現在有點問題，請照服員幫我看一下。');
    save();
    return;
  }
  showError('');
  st.history.push({ role: 'assistant', content: out.reply });
  st.lastReply = out.reply;
  addLog('bot', out.reply);
  robot.expression('happy');
  speak(out.reply);
  if (out.alert) {
    st.ui.alert.querySelector('.chat-alert-text').textContent = out.alert_reason || '長輩剛剛說的話可能需要關心一下';
    st.ui.alert.hidden = false;
  }
  save();
  if (st.pending.length) {                  // 等回答時長輩又說了話：接著送（已經顯示過了）
    const more = st.pending.join('，');
    st.pending = [];
    setTimeout(() => ask(more, { logged: true }), 300);
  }
}

// ---------------------------------------------------------------- 打招呼、換話題

function greet() {
  st.greeted = true;
  const name = elderName();
  const hello = `${name ? name + '，' : ''}你好！我是小寶。想聊什麼都可以直接跟我說喔。`;
  st.history.push({ role: 'assistant', content: hello });
  st.lastReply = hello;
  addLog('bot', hello);
  robot.expression('happy');
  speak(hello);
}

function changeTopic() {
  if (st.muted) setMuted(false);
  const choices = TOPICS.filter((t) => t !== st.lastTopic);
  st.lastTopic = choices[Math.floor(Math.random() * choices.length)];
  addLog('note', `（換個話題：${st.lastTopic}）`);
  ask(`（照服員按了「換個話題」。請改聊「${st.lastTopic}」，用一個簡單、溫暖的問題開始。）`, { hidden: true });
}

/** 這一頁不處理的話：跟小寶聊天（太短的雜音不算；小寶安靜的時候不回話） */
function onUnhandled(text) {
  if (st.muted) return false;
  if (text.replace(/[\s，。！？、,.!?]/g, '').length < 2) return false;
  ask(text);
  return true;
}

// ---------------------------------------------------------------- 計時：說完回到「在聽」、大廳裡沒人說話時問一句

setInterval(() => {
  if (!st.ui) return;
  const now = performance.now();
  const mode = st.ui.panel.dataset.mode;
  if (mode === 'speaking' && now > st.speakingUntil && !sayQueue.length) {
    setMode(st.muted ? 'muted' : 'listening', idleStatus());
    st.lastActivity = now;
  }
  if (st.lobby && !st.muted && !st.busy && voice.listening && mode === 'listening'
      && now - st.lastActivity > SILENCE_MS && st.nudges < MAX_NUDGES) {
    st.nudges += 1;
    ask('（長輩一陣子沒有說話。請溫和地問一個很簡單、容易回答的問題，或換一個輕鬆的話題。）', { hidden: true });
  }
}, 500);

// ---------------------------------------------------------------- 放到頁面上

let mounted = false;
/** 放上小寶，跟著網頁一起開始聽。page：現在這一頁的名稱（告訴小寶長輩在哪裡） */
export async function mountChat(page) {
  if (mounted) return;
  mounted = true;
  st.page = page || '';
  st.lobby = page === '大廳';
  try {
    const status = await (await fetch('/api/status')).json();
    if (!status.chat) return;               // 伺服器沒開聊天功能（config.json 的 chat）：不顯示小寶
  } catch {}
  st.ui = buildUi();
  restore();
  renderLog();
  setMuted(st.muted);
  if (st.lastReply) st.ui.$('.chat-say').textContent = st.lastReply;
  st.lastActivity = performance.now();

  voice.fallback(onUnhandled);
  voice.command(['換個話題', '換話題', '聊別的', '聊點別的'], () => changeTopic());
  voice.command(['小寶安靜一下', '小寶安靜', '安靜一下', '先不要說話'], () => { if (st.muted) return false; setMuted(true, true); });
  voice.command(['小寶', '小寶小寶', '我想聊天', '聊天'], () => { if (!st.muted) return false; setMuted(false, true); });

  // 麥克風真的開始收音之後（點過畫面），第一次就打招呼（換頁不再打招呼）
  voice.onStarted(() => { st.lastActivity = performance.now(); if (!st.greeted && !st.muted) greet(); });
  voice.autoStart();
}

export const chat = {
  get muted() { return st.muted; },
  mute: () => setMuted(true),
  unmute: () => setMuted(false),
};
