// chat.js：跟機器人「小寶」聊天。每一頁都有（ui.js 的 mountTopbar 和大廳會呼叫 mountChat），遊戲不用改。
//
//   · 右下角「跟小寶聊天」按鈕，或說「聊天」「小寶」就打開；說「再見」「結束」或按「關閉」就關上
//   · 打開的時候，說的話都交給小寶（遊戲的語音指令暫時不會被按到，只有「回大廳」還有用）
//   · 換頁的時候對話會接著聊（存在這個分頁的 sessionStorage，關掉瀏覽器就沒了，不會存檔）
//   · 小寶知道長輩現在在哪一頁，問「這個怎麼玩」可以簡單說明
//   · 長輩一陣子沒說話：溫和地問一句（最多兩次）；「換個話題」挑懷舊的話題
//   · 長輩提到身體不舒服、跌倒、不想活了：畫面最上面出現「請照服員注意」（只給照服員看）
//   · 打開、關上時會發出 window 事件 chat:open／chat:close，遊戲可以接著暫停或繼續
//
// 伺服器：POST /api/chat（pose_service/chat.py，用 Claude）。聲音在這台電腦辨識，只有文字會送出去。
import { robot } from './pose.js';
import { voice } from './voice.js';

const SILENCE_MS = 45000;    // 長輩這麼久沒說話，小寶就問一句
const MAX_NUDGES = 2;        // 最多主動問幾次
const SAY_GAP_MS = 1000;     // 一句一句說（機器人同一個動作 0.8 秒內只能叫一次）
const MAX_LOG = 10;
const STORE = 'chat-session';
const TOPICS = ['家鄉', '年輕時候的工作', '最拿手的一道菜', '喜歡的老歌', '小時候玩的遊戲', '過年過節的回憶',
  '家裡的人', '今天的天氣', '最近吃到的好吃東西', '以前住的房子', '第一次出遠門', '喜歡的花或植物'];

const st = {
  page: '', open: false, busy: false, history: [], log: [], pending: [], lastReply: '',
  lastActivity: 0, nudges: 0, speakingUntil: 0, lastTopic: null, ui: null, available: true,
};

// ---------------------------------------------------------------- 存這個分頁的對話（換頁接著聊）

function save() {
  try {
    sessionStorage.setItem(STORE, JSON.stringify({ open: st.open, history: st.history.slice(-30), log: st.log, lastReply: st.lastReply }));
  } catch {}
}
function restore() {
  try {
    const s = JSON.parse(sessionStorage.getItem(STORE));
    if (s) Object.assign(st, { history: s.history || [], log: s.log || [], lastReply: s.lastReply || '', open: !!s.open });
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
  const faceHtml = '<span class="chat-face"><i></i><i></i><b></b></span>';
  const fab = el('button', 'chat-fab');
  fab.type = 'button';
  fab.innerHTML = `${faceHtml}<span>跟小寶聊天</span>`;

  const panel = el('section', 'chat-panel');
  panel.hidden = true;
  panel.setAttribute('aria-label', '跟小寶聊天');
  panel.innerHTML = `
    <div class="chat-head">${faceHtml}<div class="chat-status">我在聽</div><button type="button" class="chat-close">關閉</button></div>
    <div class="chat-say"></div>
    <div class="chat-log"></div>
    <div class="chat-actions"><button type="button" class="chat-topic">換個話題</button><button type="button" class="chat-again">再說一次</button></div>
    <details class="chat-more"><summary>照服員設定</summary>
      <label>怎麼稱呼長輩（例如：張爺爺）<input class="chat-name" type="text" maxlength="20" placeholder="不填就不稱呼名字"></label>
      <label>用打字的<span class="chat-type"><input class="chat-text" type="text" maxlength="200" placeholder="打字後按送出"><button type="button" class="chat-send">送出</button></span></label>
      <p class="chat-note">聲音在這台電腦辨識，只有文字會送到 Claude（Anthropic）產生回答，不會存檔。</p>
      <p class="chat-error" hidden></p>
      <button type="button" class="chat-clear">清除這次的對話</button>
    </details>`;

  const alert = el('div', 'chat-alert');
  alert.hidden = true;
  alert.innerHTML = '<div><b>請照服員注意</b><span class="chat-alert-text"></span></div><button type="button">知道了</button>';

  document.body.append(fab, panel, alert);
  const $ = (sel) => panel.querySelector(sel);
  const name = $('.chat-name');
  name.value = elderName();
  name.onchange = () => { try { localStorage.setItem('chat-name', name.value.trim()); } catch {} };
  fab.onclick = () => openChat();
  $('.chat-close').onclick = () => closeChat();
  $('.chat-topic').onclick = () => changeTopic();
  $('.chat-again').onclick = () => { if (st.lastReply) speak(st.lastReply); };
  $('.chat-send').onclick = () => {
    const t = $('.chat-text').value.trim();
    if (!t) return;
    $('.chat-text').value = '';
    ask(t);
  };
  $('.chat-text').onkeydown = (e) => { if (e.key === 'Enter') $('.chat-send').click(); };
  $('.chat-clear').onclick = () => { st.history = []; st.log = []; st.lastReply = ''; renderLog(); save(); greet(); };
  alert.querySelector('button').onclick = () => { alert.hidden = true; };
  return { fab, panel, alert, $ };
}

function setMode(mode, status) {
  st.ui.panel.dataset.mode = mode;          // listening／thinking／speaking：小寶的臉跟著變
  if (status !== undefined) st.ui.$('.chat-status').textContent = status;
}

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
  if (text) st.ui.$('.chat-more').open = true;
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
  setMode('speaking', '');
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
  setMode('thinking', '想一想…');
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

// ---------------------------------------------------------------- 打開、關上、換話題

function greet() {
  const name = elderName();
  const hello = `${name ? name + '，' : ''}你好！我是小寶，想陪你聊聊天。你今天過得怎麼樣？`;
  st.history.push({ role: 'assistant', content: hello });
  st.lastReply = hello;
  addLog('bot', hello);
  robot.expression('happy');
  speak(hello);
}

function openChat({ silent = false } = {}) {
  if (!st.ui) return false;
  st.open = true;
  st.ui.panel.hidden = false;
  st.ui.fab.hidden = true;
  st.nudges = 0;
  st.lastActivity = performance.now();
  voice.capture(CHAT_COMMANDS, (text) => { ask(text); return true; });
  if (!voice.listening && !silent) voice.start();   // 按按鈕時順便打開麥克風（瀏覽器規定要按過才能開）
  renderLog();
  if (!silent) {
    if (st.history.length) speak(st.lastReply ? '我回來了，我們繼續聊。' : '你好，我在這裡。');
    else greet();
  } else {
    setMode('listening', '我在聽');
    if (st.lastReply) st.ui.$('.chat-say').textContent = st.lastReply;
  }
  save();
  window.dispatchEvent(new Event('chat:open'));
}

function closeChat({ bye = false } = {}) {
  if (!st.open) return false;
  st.open = false;
  voice.release();
  st.ui.panel.hidden = true;
  st.ui.fab.hidden = false;
  if (bye) { robot.say('今天聊得很開心，謝謝你陪我聊天，我們下次再聊！'); robot.nod(); }
  save();
  window.dispatchEvent(new Event('chat:close'));
}

function changeTopic() {
  if (!st.open) return false;
  const choices = TOPICS.filter((t) => t !== st.lastTopic);
  st.lastTopic = choices[Math.floor(Math.random() * choices.length)];
  addLog('note', `（換個話題：${st.lastTopic}）`);
  ask(`（照服員按了「換個話題」。請改聊「${st.lastTopic}」，用一個簡單、溫暖的問題開始。）`, { hidden: true });
}

// 聊天視窗開著的時候還認的指令（整句話就是指令才算）
const CHAT_COMMANDS = [
  { phrases: ['換個話題', '換話題', '聊別的', '聊點別的'], run: () => changeTopic() },
  { phrases: ['再說一次', '再講一次', '再說一遍', '說一遍', '聽不清楚'], run: () => { if (st.lastReply) speak(st.lastReply); } },
  { phrases: ['再見', '掰掰', '結束', '不聊了', '關閉', 'bye'], run: () => closeChat({ bye: true }) },
];

// ---------------------------------------------------------------- 計時：說完回到「在聽」、沒人說話時問一句

setInterval(() => {
  if (!st.ui || !st.open) return;
  const now = performance.now();
  if (st.ui.panel.dataset.mode === 'speaking' && now > st.speakingUntil && !sayQueue.length) {
    setMode('listening', '我在聽，你可以慢慢說');
    st.lastActivity = now;
  }
  if (!st.busy && st.ui.panel.dataset.mode === 'listening' && now - st.lastActivity > SILENCE_MS && st.nudges < MAX_NUDGES) {
    st.nudges += 1;
    ask('（長輩一陣子沒有說話。請溫和地問一個很簡單、容易回答的問題，或換一個輕鬆的話題。）', { hidden: true });
  }
}, 500);

// ---------------------------------------------------------------- 放到頁面上

let mounted = false;
/** 在頁面放上「跟小寶聊天」。page：現在這一頁的名稱（告訴小寶長輩在哪裡） */
export async function mountChat(page) {
  if (mounted) return;
  mounted = true;
  st.page = page || '';
  try {
    const status = await (await fetch('/api/status')).json();
    if (!status.chat) return;               // 伺服器沒開聊天功能（config.json 的 chat）：不顯示
  } catch {}
  st.ui = buildUi();
  restore();
  renderLog();
  // 說「聊天」「小寶」就打開
  voice.command(['跟小寶聊天', '我想聊天', '想聊天', '聊天', '小寶'], () => { if (st.open) return false; openChat(); });
  if (st.open) openChat({ silent: true });  // 上一頁聊天視窗開著：這一頁接著開（不重新打招呼）
}

export const chat = {
  open: () => openChat(),
  close: () => closeChat(),
  get isOpen() { return st.open; },
};
