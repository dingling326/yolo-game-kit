// voice.js：語音互動。每個遊戲頁都會自動有（ui.js 的 mountTopbar 會呼叫 mountVoice），遊戲不一定要改。
//
// 會做的事：
//   · 左下角的「🎤」按鈕：按一下開始聽（瀏覽器規定要按一下才能開麥克風和出聲音）
//   · 一直聽，有人說完一句話，就送到伺服器辨識（POST /api/asr，用 Whisper，在這台電腦上跑）
//   · 聽到指令就照做。這些指令每一頁都有，不用寫程式：
//       「開始／再玩一次／start」 → 按 id="start" 的按鈕
//       「跳過／下一題／skip」   → 按 id="skip" 的按鈕
//       「再說一次／repeat」     → 按 id="repeat" 的按鈕；沒有這個按鈕就把機器人上一句話再唸一次
//       「重來／歸零／reset」    → 按 id="reset" 的按鈕
//       「回大廳／回首頁」       → 回到大廳
//   · 機器人說話（robot.say）時，用電腦喇叭唸出來（模擬機器人時；接真的機器人就由機器人說）
//
// 遊戲想多聽一些東西（例如用說的回答）：
//   import { voice } from '/common/voice.js';
//   voice.words(['雞蛋', '牙刷']);                  // 告訴辨識「可能會聽到這些詞」，會準很多
//   voice.command(['提示', '給我提示'], () => giveHint());   // 加一個指令
//   voice.onText((text) => { ... return true; });   // 指令以外的話交給遊戲；回傳 true 表示「我處理了」

const SAMPLE_RATE = 16000;
const START_FRAMES = 2;          // 連續幾格（每格約 85 毫秒）比雜音大聲，才算開始說話
const END_SILENCE_MS = 800;      // 安靜多久算說完一句
const MAX_MS = 8000;             // 一句最長 8 秒
const MIN_MS = 300;              // 短於 0.3 秒不算（咳嗽、碰到桌子）
const PREROLL_MS = 300;          // 往前多留一點，第一個字才不會被切掉
const AFTER_SPEAK_MS = 600;      // 電腦唸完之後等一下才開始聽，避免聽到自己的聲音

const $ = (sel, root = document) => root.querySelector(sel);
const norm = (s) => (s || '').toLowerCase().replace(/[\s，。！？、,.!?「」"'：:；;~～-]/g, '');

const BUILTIN = [
  { phrases: ['回大廳', '回到大廳', '回首頁', '大廳', 'home', 'lobby'], run: () => { location.href = '/'; } },
  { phrases: ['再說一次', '再講一次', '再說一遍', '再講一遍', '說一遍', '說一次', '再一次', '聽不清楚', '沒聽清楚', 'repeat', 'sayitagain'],
    run: () => clickIf('repeat') || repeatLast() },
  { phrases: ['跳過', '下一題', '換一題', '下一個', 'skip', 'next'], run: () => clickIf('skip') },
  { phrases: ['重來', '歸零', '重新開始', 'reset', 'restart'], run: () => clickIf('reset') || clickIf('start') },
  { phrases: ['開始', '再玩一次', '再玩', '開始玩', '開始遊戲', 'start', 'playagain', 'play'], run: () => clickIf('start') },
];

function clickIf(id) {
  const el = document.getElementById(id);
  if (!el || el.disabled || el.hidden) return false;
  el.click();
  return true;
}

// ---------------------------------------------------------------- 說話（電腦喇叭）

let lastSaid = '';
let speakingUntil = 0;
let robotIsReal = false;

function speak(text) {
  if (!text || !('speechSynthesis' in window)) return;
  lastSaid = text;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = /[一-鿿]/.test(text) ? 'zh-TW' : 'en-US';
  u.rate = 0.85;                              // 慢一點，長輩比較聽得清楚
  // 唸的時候不要聽（不然會聽到自己）。先用字數估計要唸多久（排在前面的句子也要算），唸完會再提早恢復
  const start = Math.max(performance.now(), speakingUntil);
  const ends = start + estimateMs(text);
  speakingUntil = ends;
  u.onend = () => {
    if (speakingUntil === ends && !speechSynthesis.pending) speakingUntil = performance.now() + AFTER_SPEAK_MS;
  };
  speechSynthesis.speak(u);
}

/** 估計唸完要多久：中文每個字約 0.3 秒（語速 0.85），英文每個字母約 0.08 秒 */
function estimateMs(text) {
  const zh = (text.match(/[一-鿿]/g) || []).length;
  return 800 + zh * 300 + (text.length - zh) * 80 + AFTER_SPEAK_MS;
}

function repeatLast() {
  if (!lastSaid) return false;
  speak(lastSaid);
  return true;
}

// ---------------------------------------------------------------- 狀態

const state = {
  on: false,           // 使用者有沒有開語音
  mode: 'off',         // off／listening（聽）／hearing（有人在說）／thinking（辨識中）／error
  extraWords: [],
  commands: [],
  textHandlers: [],
  ui: null,
};

function setMode(mode, detail = '') {
  state.mode = mode;
  state.ui?.render(mode, detail);
}

// ---------------------------------------------------------------- 錄音＋判斷有沒有人在說話

let ctx = null;
let stream = null;
let proc = null;

async function startMic() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  proc = ctx.createScriptProcessor(4096, 1, 1);
  const frameMs = (4096 / ctx.sampleRate) * 1000;
  const preFrames = Math.ceil(PREROLL_MS / frameMs);
  let noise = 0.005;           // 背景雜音的音量（會自己慢慢調整）
  let loud = 0;
  let talking = false;
  let silentMs = 0;
  let chunks = [];
  let needQuietMs = 0;         // 剛停止聽（電腦在說話）：要先安靜一下才開始收，避免只收到半句話
  const pre = [];

  proc.onaudioprocess = (e) => {
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    if (!state.on || state.mode === 'thinking' || performance.now() < speakingUntil) {
      talking = false; chunks = []; loud = 0;
      needQuietMs = 300;
      return;
    }
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const threshold = Math.max(noise * 3, 0.012);

    if (needQuietMs > 0) {                    // 恢復聽的時候有人正在說：這句只剩後半段，不收
      needQuietMs = rms < threshold ? needQuietMs - frameMs : 300;
      return;
    }
    if (!talking) {
      pre.push(data);
      if (pre.length > preFrames) pre.shift();
      if (rms > threshold) {
        if (++loud >= START_FRAMES) {
          talking = true; silentMs = 0; chunks = [...pre]; setMode('hearing');
        }
      } else {
        loud = 0;
        noise = 0.95 * noise + 0.05 * rms;    // 沒人說話時，學習背景雜音有多大
      }
      return;
    }
    chunks.push(data);
    silentMs = rms > threshold * 0.7 ? 0 : silentMs + frameMs;
    const totalMs = chunks.length * frameMs;
    if (silentMs >= END_SILENCE_MS || totalMs >= MAX_MS) {
      talking = false; loud = 0;
      const speechMs = totalMs - silentMs;
      const audio = chunks; chunks = [];
      if (speechMs >= MIN_MS) recognise(audio, ctx.sampleRate);
      else setMode('listening');
    }
  };
  src.connect(proc);
  proc.connect(ctx.destination);              // ScriptProcessor 要接到輸出才會跑（輸出是靜音）
}

function stopMic() {
  proc?.disconnect();
  stream?.getTracks().forEach((t) => t.stop());
  ctx?.close();
  proc = stream = ctx = null;
}

// ---------------------------------------------------------------- 送去辨識

function toWav(chunks, rate) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = rate / SAMPLE_RATE;            // 降到 16 kHz：每 ratio 個取平均
  const n = Math.floor(len / ratio);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(len, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const dv = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, SAMPLE_RATE, true); dv.setUint32(28, SAMPLE_RATE * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

function vocabulary() {
  const words = new Set(state.extraWords);
  for (const c of [...state.commands, ...BUILTIN]) for (const p of c.phrases.slice(0, 2)) words.add(p);
  return [...words].join('、');
}

async function recognise(chunks, rate) {
  setMode('thinking');
  try {
    const res = await fetch(`/api/asr?prompt=${encodeURIComponent(vocabulary())}`, {
      method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: toWav(chunks, rate),
    });
    const out = await res.json();
    if (!state.on) { setMode('off'); return; }      // 辨識的時候使用者已經關掉語音
    if (!out.ok) { setMode('error', out.error); setTimeout(() => state.on && setMode('listening'), 3000); return; }
    if (!out.text) { setMode('listening'); return; }
    const did = handle(out.text);
    setMode('listening', did ? `聽到：「${out.text}」` : `聽到：「${out.text}」（沒有這個指令）`);
  } catch (e) {
    setMode('error', '連不到辨識服務');
    setTimeout(() => state.on && setMode('listening'), 3000);
  }
}

/** 指令比對：遊戲自己加的指令優先，再來是內建指令，最後交給 onText */
function handle(text) {
  const t = norm(text);
  for (const c of [...state.commands, ...BUILTIN]) {
    if (c.phrases.some((p) => t.includes(norm(p)))) {
      if (c.run(text) !== false) return true;
    }
  }
  for (const h of state.textHandlers) if (h(text)) return true;
  return false;
}

// ---------------------------------------------------------------- 左下角的麥克風按鈕

function mountUi() {
  const el = document.createElement('div');
  el.className = 'voice';
  el.innerHTML = `<button type="button" class="voice-btn" aria-label="語音"><span class="voice-icon">🎤</span><span class="voice-label"></span></button><div class="voice-detail"></div>`;
  document.body.append(el);
  const btn = $('.voice-btn', el), label = $('.voice-label', el), detail = $('.voice-detail', el);
  const LABELS = { off: '按一下用說的', listening: '我在聽…', hearing: '請說…', thinking: '聽懂中…', error: '語音有問題' };
  let detailTimer;
  btn.onclick = () => (state.on ? voice.stop() : voice.start());
  return {
    render(mode, text) {
      el.dataset.mode = mode;
      label.textContent = LABELS[mode] || '';
      if (text) {
        detail.textContent = text;
        clearTimeout(detailTimer);
        detailTimer = setTimeout(() => { detail.textContent = ''; }, 5000);
      }
    },
  };
}

// ---------------------------------------------------------------- 給遊戲用的

export const voice = {
  /** 開始聽（要在使用者按下按鈕之後呼叫，瀏覽器才允許開麥克風） */
  async start() {
    if (state.on) return;
    state.on = true;
    try { localStorage.setItem('voice-on', '1'); } catch {}
    setMode('listening');
    try {
      if (!ctx) await startMic();
      else await ctx.resume();
    } catch (e) {
      state.on = false;
      setMode('error', e.name === 'NotAllowedError' ? '瀏覽器沒有允許使用麥克風' : '找不到麥克風');
    }
  },
  stop() {
    state.on = false;
    try { localStorage.setItem('voice-on', '0'); } catch {}
    stopMic();
    setMode('off');
  },
  /** 這一頁可能會聽到的詞（例如圖卡名稱），辨識會準很多 */
  words(list) { state.extraWords = [...list]; },
  /** 加一個指令：phrases 裡任何一個詞出現在句子裡就執行 run(句子)。run 回傳 false 表示「這次不算」 */
  command(phrases, run) { state.commands.push({ phrases, run }); },
  /** 指令以外的話：handler(句子) 回傳 true 表示處理了 */
  onText(handler) { state.textHandlers.push(handler); },
  /** 用電腦喇叭唸出來 */
  speak,
  /** 機器人說話：模擬機器人時用電腦喇叭唸；接真的機器人就不唸（機器人自己會說） */
  robotSaid(text) {
    if (!robotIsReal) { speak(text); return; }
    // 真的機器人在說話：麥克風會聽到它（例如它說「請拿出雞蛋」會被當成回答），估計說完之前先不要聽
    lastSaid = text;
    speakingUntil = Math.max(speakingUntil, performance.now()) + estimateMs(text);
  },
  get listening() { return state.on; },
};

let mounted = false;
/** 在頁面放上麥克風按鈕。ui.js 的 mountTopbar 會自動呼叫，大廳也會呼叫 */
export async function mountVoice() {
  if (mounted) return;
  mounted = true;
  state.ui = mountUi();
  setMode('off');
  try {
    const status = await (await fetch('/api/status')).json();
    robotIsReal = status.robot_mode !== 'mock';
    if (!status.asr) {                        // 伺服器沒開語音辨識：只保留「唸出來」，不顯示麥克風
      document.querySelector('.voice')?.remove();
      return;
    }
  } catch {}
  // 上一頁有開語音：瀏覽器要求「使用者按過一下」才能再開，所以等第一次點畫面就自動開
  let wanted = false;
  try { wanted = localStorage.getItem('voice-on') === '1'; } catch {}
  if (wanted) {
    setMode('off', '點一下畫面任何地方，就會繼續聽');
    const resume = () => { if (!state.on) voice.start(); };
    window.addEventListener('pointerdown', resume, { once: true, capture: true });
    window.addEventListener('keydown', resume, { once: true, capture: true });
  }
}
