// 跟機器人聊天：長輩用說的（左下角 🎤），機器人用 Claude 想回答，再用說的回應。
//
//   · 聲音在這台電腦辨識成文字（Whisper），文字送到伺服器 /api/chat，伺服器問 Claude（pose_service/chat.py）
//   · 回答很短、慢慢唸；一次只問一個問題
//   · 長輩一陣子沒說話：溫和地問一個簡單的問題（最多兩次，之後就安靜等）
//   · 「換個話題」：從家鄉、年輕時的工作、拿手菜、老歌…挑一個（懷舊的話題長輩比較有話聊）
//   · 長輩提到身體不舒服、跌倒、不想活了：畫面上方出現「請照服員注意」（不會嚇到長輩，只給照服員看）
//   · 語音指令只在「整句話就是指令」時才算（「我開始學做菜」不會按到「開始」）
import { connect, robot } from '/common/pose.js';
import { mountTopbar, mountRobot } from '/common/ui.js';
import { voice } from '/common/voice.js';

const SILENCE_MS = 45000;    // 長輩這麼久沒說話，機器人就問一句
const MAX_NUDGES = 2;        // 最多主動問幾次（之後安靜等，不要一直吵）
const SAY_GAP_MS = 1000;     // 一句一句說（機器人同一個動作 0.8 秒內只能叫一次）
const MAX_LOG = 12;          // 對話紀錄最多顯示幾則
const TOPICS = ['家鄉', '年輕時候的工作', '最拿手的一道菜', '喜歡的老歌', '小時候玩的遊戲', '過年過節的回憶',
  '家裡的人', '今天的天氣', '最近吃到的好吃東西', '以前住的房子', '第一次搭火車或坐車出遠門', '喜歡的花或植物'];

const $ = (id) => document.getElementById(id);
const topbar = mountTopbar('跟機器人聊天');
const robotBox = mountRobot($('robot'));

let chatting = false;
let busy = false;                // 正在等 Claude 回答
let history = [];                // [{role: 'user'|'assistant', content}]
let pending = [];                // 等回答的時候長輩又說的話，等一下一起送
let lastReply = '';
let lastActivity = 0;
let nudges = 0;
let speakingUntil = 0;
let lastTopic = null;

try { $('name').value = localStorage.getItem('chat-name') || ''; } catch {}
$('name').onchange = () => { try { localStorage.setItem('chat-name', $('name').value.trim()); } catch {} };
const elderName = () => $('name').value.trim();

// ---------------------------------------------------------------- 畫面

function setMode(mode, status) {
  $('talk').dataset.mode = mode;            // listening／thinking／speaking／idle：機器人的臉跟著變
  if (status !== undefined) $('status').textContent = status;
}

function addLog(kind, text) {
  const log = $('log');
  if (log.querySelector('.muted')) log.innerHTML = '';
  const p = document.createElement('div');
  p.className = `msg ${kind}`;
  p.textContent = text;
  log.append(p);
  while (log.children.length > MAX_LOG) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function showAlert(reason) {
  $('alert-text').textContent = reason || '長輩剛剛說的話可能需要關心一下';
  $('alert').hidden = false;
}
$('alert-ok').onclick = () => { $('alert').hidden = true; };

function showError(text) {
  $('error').textContent = text;
  $('error').hidden = !text;
  if (text) $('setup').open = true;
}

// ---------------------------------------------------------------- 說話

const sayQueue = [];
let sayTimer = null;
let lastSayAt = -Infinity;
/** 把回答切成一句一句（機器人一次最多說 100 個字），排隊說 */
function speak(text) {
  $('say').textContent = text;
  const parts = text.match(/[^。！？!?]+[。！？!?]?/g) || [text];
  let chunk = '';
  for (const s of parts) {
    if ((chunk + s).length > 90 && chunk) { sayQueue.push(chunk); chunk = ''; }
    chunk += s;
  }
  if (chunk) sayQueue.push(chunk);
  // 估計要說多久（中文每個字約 0.3 秒），這段時間臉上的嘴巴會動
  const zh = (text.match(/[一-鿿]/g) || []).length;
  speakingUntil = performance.now() + 800 + zh * 300 + sayQueue.length * SAY_GAP_MS;
  setMode('speaking', '');
  pumpSay();
}
function pumpSay() {
  if (sayTimer || !sayQueue.length) return;
  const wait = Math.max(0, lastSayAt + SAY_GAP_MS - performance.now());
  sayTimer = setTimeout(() => {
    sayTimer = null;
    lastSayAt = performance.now();
    robot.say(sayQueue.shift());              // 唸出來由 ui.js 處理（模擬機器人時用電腦喇叭）
    pumpSay();
  }, wait);
}

// 說完之後，臉回到「在聽」
setInterval(() => {
  const now = performance.now();
  if ($('talk').dataset.mode === 'speaking' && now > speakingUntil && !sayQueue.length) {
    setMode(chatting ? 'listening' : 'idle', chatting ? '我在聽，你可以慢慢說' : '按「開始聊天」，就可以跟我聊天');
    lastActivity = now;
  }
  // 長輩一陣子沒說話：溫和地問一句（最多兩次）
  if (chatting && !busy && $('talk').dataset.mode === 'listening' && now - lastActivity > SILENCE_MS && nudges < MAX_NUDGES) {
    nudges += 1;
    ask('（長輩一陣子沒有說話。請溫和地問一個很簡單、容易回答的問題，或換一個輕鬆的話題。）', { hidden: true });
  }
}, 500);

// ---------------------------------------------------------------- 問 Claude

/**
 * 送一句話。hidden：照服員或程式給的提示，不顯示在對話紀錄；logged：已經顯示過了（等回答時先說的話）
 */
async function ask(text, { hidden = false, logged = false } = {}) {
  text = text.trim();
  if (!text) return;
  if (busy) { if (!hidden) { pending.push(text); addLog('user', text); } return; }
  busy = true;
  if (!hidden) nudges = 0;
  if (!hidden && !logged) addLog('user', text);
  history.push({ role: 'user', content: text });
  lastActivity = performance.now();
  setMode('thinking', '想一想…');
  robot.expression('expecting');
  let out;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, name: elderName() }),
    });
    out = await res.json();
  } catch {
    out = { ok: false, error: '連不到辨識服務' };
  }
  busy = false;
  if (!out.ok) {
    history.pop();                            // 這句沒有得到回答，從紀錄拿掉，下次重新送
    showError(`聊天出問題：${out.error}`);
    addLog('note', '（機器人沒有回答，請照服員看「照服員設定」）');
    speak('不好意思，我現在有點問題，請照服員幫我看一下。');
    return;
  }
  showError('');
  history.push({ role: 'assistant', content: out.reply });
  lastReply = out.reply;
  addLog('bot', out.reply);
  robot.expression('happy');
  speak(out.reply);
  if (out.alert) showAlert(out.alert_reason);
  if (pending.length) {                       // 等回答的時候長輩又說了話：接著送（已經顯示過了）
    const more = pending.join('，');
    pending = [];
    setTimeout(() => ask(more, { logged: true }), 300);
  }
}

// ---------------------------------------------------------------- 開始、換話題、結束

async function start() {
  if (chatting) return;
  chatting = true;
  history = []; pending = []; nudges = 0;
  $('log').innerHTML = '';
  $('start').disabled = true;
  for (const id of ['skip', 'repeat', 'end']) $(id).disabled = false;
  if (!voice.listening) voice.start();       // 按按鈕的時候順便打開麥克風（瀏覽器規定要按過才能開）
  const name = elderName();
  const hello = `${name ? name + '，' : ''}你好！我是小寶，想陪你聊聊天。你今天過得怎麼樣？`;
  history.push({ role: 'assistant', content: hello });
  lastReply = hello;
  addLog('bot', hello);
  robot.expression('happy');
  speak(hello);
}

function changeTopic() {
  if (!chatting) return false;
  const topic = TOPICS.filter((t) => t !== lastTopic)[Math.floor(Math.random() * (TOPICS.length - 1))];
  lastTopic = topic;
  addLog('note', `（換個話題：${topic}）`);
  ask(`（照服員按了「換個話題」。請改聊「${topic}」，用一個簡單、溫暖的問題開始。）`, { hidden: true });
}

function end() {
  if (!chatting) return false;
  chatting = false;
  $('start').disabled = false;
  $('start').textContent = '再聊一次';
  for (const id of ['skip', 'repeat', 'end']) $(id).disabled = true;
  const bye = '今天聊得很開心，謝謝你陪我聊天，我們下次再聊！';
  addLog('bot', bye);
  robot.expression('happy');
  speak(bye);
  setTimeout(() => robot.nod(), 1200);
}

$('start').onclick = start;
$('skip').onclick = changeTopic;
$('end').onclick = end;
$('repeat').onclick = () => { if (lastReply) speak(lastReply); };
$('send').onclick = () => {
  const text = $('text').value.trim();
  if (!text) return;
  $('text').value = '';
  if (!chatting) start();
  ask(text);
};
$('text').onkeydown = (e) => { if (e.key === 'Enter') $('send').click(); };

// ---------------------------------------------------------------- 語音

voice.strictCommands(true);                   // 聊天什麼都可能說：整句話就是指令才算
voice.command(['換個話題', '換話題', '聊別的', '聊點別的'], () => changeTopic());
voice.command(['結束', '不聊了', '再見', '掰掰', 'bye'], () => end());
voice.onText((text) => {                      // 指令以外的話，都是在跟機器人聊天
  if (!chatting) return false;
  ask(text);
  return true;
});

setMode('idle');
connect({
  onPose: () => {},                           // 聊天不用看攝影機
  onHello: (msg) => topbar.hello(msg),
  onStatus: (connected) => topbar.status(connected),
  onRobot: (msg) => robotBox.show(msg),
});
fetch('/api/status').then((r) => r.json()).then((s) => {
  if (!s.chat) showError('聊天功能沒有開：請把 config.json 的 chat 改成 true，重開伺服器');
}).catch(() => {});
