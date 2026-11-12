// pose.js：遊戲共用的工具。在遊戲裡這樣用：
//   import { connect, createStage, isHandUp, Hold, robot } from '/common/pose.js';
//
// 一個「人」(person) 長這樣：
//   { id: 0, score: 0.9, box: [x1, y1, x2, y2], kp: [[x, y, 信心], ... 17 個] }
// 座標都是 0～1：x 從畫面左到右，y 從上到下（越上面 y 越小）。
// left／right 是被拍的人「自己的」左右。
//
// 一張「圖卡」(card) 長這樣（在 onPose 的第二個參數 msg.cards 裡）：
//   { id: 2, name: '貓', en: 'cat', emoji: '🐱', corners: [[x, y] × 4], center: [x, y], size: 0.12 }
//
// 一隻「手」(hand) 長這樣（在 msg.hands 裡）：
//   { side: 'left', score: 0.96, kp: [[x, y] × 21], center: [x, y], size: 0.2,
//     fingers: [拇指, 食指, 中指, 無名指, 小指] 有沒有伸直, count: 伸直幾根, gesture: 'rock'／'paper'／… 或 null }

export const NAMES = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
];
let SKELETON = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16], [0, 1], [0, 2], [1, 3], [2, 4]];
let HAND_CONNECTIONS = [];      // 連上之後由伺服器給（21 個點怎麼連）
const INDEX = Object.fromEntries(NAMES.map((n, i) => [n, i]));
// 畫面的寬÷高。座標是 0～1，但畫面不是正方形，算角度前要先把 x 拉回真實比例（connect() 會自動更新）
let ASPECT = 4 / 3;

// ---------------------------------------------------------------- 讀關節

/** 取一個關節：{x, y, c}。看不清楚（信心低於 minConf）就回傳 null */
export function point(person, name, minConf = 0.3) {
  const p = person?.kp?.[INDEX[name]];
  if (!p || p[2] < minConf) return null;
  return { x: p[0], y: p[1], c: p[2] };
}

/** 兩個關節的距離（0～1 的座標） */
export function distance(a, b) {
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
}

/** 手有沒有舉起來：手腕比肩膀高。side 是 'left' 或 'right' */
export function isHandUp(person, side) {
  const wrist = point(person, side + '_wrist');
  const shoulder = point(person, side + '_shoulder');
  return !!(wrist && shoulder && wrist.y < shoulder.y - 0.05);
}

/** 畫面裡最大（通常是最靠近鏡頭）的那個人；沒有人就是 null */
export function mainPerson(people) {
  return people?.[0] ?? null;
}

/**
 * 三個關節的夾角（度），角在中間那個 b。例如手肘彎多少：angle(肩, 肘, 腕)，打直是 180。
 * 有一個看不清楚就回傳 null。
 */
export function angle(a, b, c) {
  if (!a || !b || !c) return null;
  const v1 = [(a.x - b.x) * ASPECT, a.y - b.y];
  const v2 = [(c.x - b.x) * ASPECT, c.y - b.y];
  const n = Math.hypot(...v1) * Math.hypot(...v2);
  if (!n) return null;
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / n;
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/**
 * 手臂抬多高（度）：手垂下是 0、平舉是 90、舉到頭頂正上方是 180。
 * 只用肩膀和手腕（手腕看不到就用手肘），所以坐著、下半身被擋住也能用。side 是 'left' 或 'right'
 */
export function armLift(person, side) {
  const shoulder = point(person, side + '_shoulder');
  const hand = point(person, side + '_wrist') || point(person, side + '_elbow');
  if (!shoulder || !hand) return null;
  const below = { x: shoulder.x, y: shoulder.y + 0.1 };     // 肩膀正下方的一點
  return angle(below, shoulder, hand);
}

/**
 * 選出要看的那個人：身體中心在 zone 範圍裡、最大的那一個（沒有就是 null）。
 * 長照現場照服員常站在旁邊，用 mainPerson 可能會選到照服員；把 zone 設成畫面中間就不會。
 * zone 是攝影機的 x（0～1）；畫面是鏡像的，但中間的範圍左右對稱，不用管鏡像。
 */
export function pickPlayer(people, zone = [0.25, 0.75]) {
  for (const p of people || []) {                  // people 已經從大排到小
    const cx = (p.box[0] + p.box[2]) / 2;
    if (cx >= zone[0] && cx <= zone[1]) return p;
  }
  return null;
}

/**
 * 量「這個人最多能做到多少」，拿來設定每個人自己的目標（校正）。
 *   const reach = new Reach();
 *   reach.update(armLift(p, 'left'));       // 校正的那幾秒，每張畫面呼叫
 *   reach.target(0.8, 60, 150)              // 目標＝最大值的 8 成，但不低於 60、不高於 150
 * 會先取最近 5 張的中位數再算最大值，辨識跳一下不會被當成最大值。
 */
export class Reach {
  constructor(window = 5) { this.window = window; this.buf = []; this.max = null; }
  update(value) {
    if (value === null || value === undefined) return this.max;
    this.buf.push(value);
    if (this.buf.length > this.window) this.buf.shift();
    if (this.buf.length < this.window) return this.max;
    const median = [...this.buf].sort((a, b) => a - b)[Math.floor(this.window / 2)];
    this.max = this.max === null ? median : Math.max(this.max, median);
    return this.max;
  }
  target(ratio = 0.8, min = -Infinity, max = Infinity) {
    if (this.max === null) return min;
    return Math.max(min, Math.min(max, this.max * ratio));
  }
  reset() { this.buf = []; this.max = null; }
}

/**
 * 「維持一段時間才算」：避免辨識跳一下就得分。
 *   const hold = new Hold(500);            // 要維持 0.5 秒
 *   if (hold.update(isHandUp(p, 'left'))) { 得分 }   // 只有剛滿 0.5 秒的那一次會回傳 true
 */
export class Hold {
  constructor(ms) { this.ms = ms; this.since = null; this.fired = false; }
  update(ok, now = performance.now()) {
    if (!ok) { this.since = null; this.fired = false; return false; }
    if (this.since === null) this.since = now;
    if (!this.fired && now - this.since >= this.ms) { this.fired = true; return true; }
    return false;
  }
  /** 0～1：已經維持了多少（拿來畫進度） */
  progress(now = performance.now()) {
    return this.since === null ? 0 : Math.min(1, (now - this.since) / this.ms);
  }
  reset() { this.since = null; this.fired = false; }
}

// ---------------------------------------------------------------- 手

/** 手勢的中文名稱和圖示。hand.gesture 是 key */
export const GESTURES = {
  rock: { name: '石頭', emoji: '✊' },
  paper: { name: '布', emoji: '🖐️' },
  scissors: { name: '剪刀', emoji: '✌️' },
  thumbs_up: { name: '讚', emoji: '👍' },
  point: { name: '比一', emoji: '☝️' },
};

/** 畫面裡最大（最靠近鏡頭）的手；side 給 'left' 或 'right' 就只找那一隻。沒有手是 null */
export function mainHand(hands, side = null) {
  return (hands || []).find((h) => !side || h.side === side) ?? null;
}

/** 手的 21 個點的編號：0 手腕；拇指 1～4、食指 5～8、中指 9～12、無名指 13～16、小指 17～20（每根都是指根→指尖） */
export const HAND = { wrist: 0, thumb_tip: 4, index_tip: 8, middle_tip: 12, ring_tip: 16, pinky_tip: 20 };

// ---------------------------------------------------------------- 圖卡

/** 畫面裡最大（通常是最靠近鏡頭）的那張卡；沒有卡就是 null */
export function mainCard(cards) {
  return cards?.[0] ?? null;
}

/** 圖卡清單（cards.json）：[{id, name, en, emoji}, ...] */
export async function loadCards() {
  return (await fetch('/api/cards')).json();
}

/**
 * 「同一個值維持一段時間才算」：Hold 是看 true／false，Steady 是看「是哪一個」。
 *   const steady = new Steady(600);
 *   const id = steady.update(mainCard(msg.cards)?.id);   // 同一張卡拿穩 0.6 秒，回傳一次它的 id；其他時候是 null
 * 判斷過的卡要先拿開（或換一張）才會再回傳，不會一直重複算分。
 */
export class Steady {
  constructor(ms) { this.ms = ms; this.value = null; this.since = 0; this.fired = false; }
  update(value, now = performance.now()) {
    value = value ?? null;
    if (value !== this.value) { this.value = value; this.since = now; this.fired = false; }
    if (value === null || this.fired || now - this.since < this.ms) return null;
    this.fired = true;
    return value;
  }
  /** 0～1：現在這個值已經維持了多少 */
  progress(now = performance.now()) {
    return this.value === null || this.fired ? 0 : Math.min(1, (now - this.since) / this.ms);
  }
  /** 現在拿著的這個值先不算（例如剛用它開始遊戲），要拿開或換一個才會再判斷 */
  ignore(value) { this.value = value ?? null; this.fired = true; }
  reset() { this.value = null; this.fired = false; }
}

// ---------------------------------------------------------------- 連線

/**
 * 連到辨識服務。斷線會自動重連。
 *   connect({
 *     onPose(people, msg) {},   // 每一張畫面呼叫一次（每秒約 15～30 次）
 *     onRobot(msg) {},          // 機器人做了什麼（或被拒絕）
 *     onHello(msg) {},          // 剛連上：影像來源、模型、機器人
 *     onStatus(connected) {},   // 連線狀態改變
 *   })
 */
export function connect(handlers = {}) {
  let ws;
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => handlers.onStatus?.(true);
    ws.onclose = () => { handlers.onStatus?.(false); setTimeout(open, 1000); };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'pose') {
        if (msg.w && msg.h) ASPECT = msg.w / msg.h;
        handlers.onPose?.(msg.people, msg);
      }
      else if (msg.type === 'robot') handlers.onRobot?.(msg);
      else if (msg.type === 'hello') {
        if (msg.skeleton) SKELETON = msg.skeleton;
        if (msg.hand_connections) HAND_CONNECTIONS = msg.hand_connections;
        handlers.onHello?.(msg);
      }
    };
  };
  open();
  return { close: () => { ws.onclose = null; ws.close(); } };
}

// ---------------------------------------------------------------- 畫面

/**
 * 在 element 裡放攝影機畫面和畫骨架用的畫布。
 *   const stage = createStage(document.querySelector('#stage'));
 *   stage.draw(people, { highlight: ['left_wrist'] });   // 在 onPose 裡呼叫
 *   stage.draw(people, { cards: msg.cards, goodCard: 2 }); // 也畫圖卡；goodCard 那張畫成綠框
 *   stage.draw(people, { hands: msg.hands });              // 也畫手（手指、手勢名稱）
 * mirror: true 像照鏡子（預設）。只是畫面左右翻轉，關節的 left／right 不變。
 */
export function createStage(element, { mirror = true } = {}) {
  element.classList.add('stage');
  element.classList.toggle('mirrored', mirror);
  const wrap = document.createElement('div');
  wrap.className = 'mirror';
  const img = new Image();
  img.alt = '攝影機畫面';
  const canvas = document.createElement('canvas');
  wrap.append(img, canvas);
  element.prepend(wrap);
  // 隱私模式（config.json 的 show_video: false）：伺服器不送影像，這裡只畫骨架
  fetch('/api/status').then((r) => r.json()).then((s) => {
    if (s.show_video) img.src = '/video.mjpg';
    else element.classList.add('no-video');
  }).catch(() => { img.src = '/video.mjpg'; });
  const ctx = canvas.getContext('2d');

  return {
    canvas, ctx,
    draw(people, { highlight = [], color = '#5be3a0', lineWidth = 4, skeleton = true, cards = [], goodCard = null,
                   hands = [], handLabels = true } = {}) {
      const w = Math.round(canvas.clientWidth * devicePixelRatio);
      const h = Math.round(canvas.clientHeight * devicePixelRatio);
      if (canvas.width !== w) canvas.width = w;       // 大小沒變就不重設（重設畫布很慢）
      if (canvas.height !== h) canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      if (skeleton) {
        for (const person of people || []) drawPerson(ctx, person, w, h, { highlight, color, lineWidth, main: person.id === 0 });
      }
      for (const card of cards || []) drawCard(ctx, card, w, h, { good: card.id === goodCard, mirror });
      for (const hand of hands || []) drawHand(ctx, hand, w, h, { mirror, label: handLabels });
    },
  };
}

/** 在畫布上寫字（畫面是鏡像的，字要再翻回來才不會反過來）。baseline：'top' 寫在點的下面、'bottom' 寫在上面 */
function label(ctx, text, x, y, mirror, baseline) {
  const dpr = devicePixelRatio;
  ctx.save();
  ctx.translate(x, y);
  if (mirror) ctx.scale(-1, 1);
  ctx.font = `700 ${22 * dpr}px "Microsoft JhengHei", "PingFang TC", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = baseline;
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0, 0, 0, .6)';
  ctx.fillRect(-tw / 2 - 8 * dpr, baseline === 'top' ? -3 * dpr : -30 * dpr, tw + 16 * dpr, 32 * dpr);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawHand(ctx, hand, w, h, { mirror, label: withLabel }) {
  const dpr = devicePixelRatio;
  const kp = hand.kp;
  ctx.lineCap = 'round';
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = '#7cc4ff';
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(kp[a][0] * w, kp[a][1] * h);
    ctx.lineTo(kp[b][0] * w, kp[b][1] * h);
    ctx.stroke();
  }
  // 指尖：伸直的畫大一點、黃色
  [4, 8, 12, 16, 20].forEach((tip, n) => {
    ctx.beginPath();
    ctx.arc(kp[tip][0] * w, kp[tip][1] * h, (hand.fingers[n] ? 6 : 3.5) * dpr, 0, Math.PI * 2);
    ctx.fillStyle = hand.fingers[n] ? '#ffd34d' : '#ffffff';
    ctx.fill();
  });
  if (withLabel) {
    const g = GESTURES[hand.gesture];
    const top = Math.min(...kp.map(([, y]) => y)) * h;
    label(ctx, g ? `${g.emoji} ${g.name}` : `${hand.count} 根手指`, hand.center[0] * w, top - 8 * dpr, mirror, 'bottom');
  }
}

function drawCard(ctx, card, w, h, { good, mirror }) {
  const dpr = devicePixelRatio;
  ctx.beginPath();
  card.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
  ctx.closePath();
  ctx.lineWidth = 5 * dpr;
  ctx.strokeStyle = good ? '#3fcf8e' : '#ffd34d';
  ctx.fillStyle = good ? 'rgba(63, 207, 142, .25)' : 'rgba(255, 211, 77, .18)';
  ctx.fill();
  ctx.stroke();

  // 名字標在方塊的下方（上方是卡片的圖，不要蓋住）
  const bottom = Math.max(...card.corners.map(([, y]) => y)) * h;
  label(ctx, card.name, card.center[0] * w, bottom + 10 * dpr, mirror, 'top');
}

function drawPerson(ctx, person, w, h, { highlight, color, lineWidth, main }) {
  const kp = person.kp;
  const lw = lineWidth * devicePixelRatio;
  ctx.lineCap = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = main ? color : 'rgba(255,255,255,.55)';
  for (const [a, b] of SKELETON) {
    if (kp[a][2] < 0.3 || kp[b][2] < 0.3) continue;
    ctx.beginPath();
    ctx.moveTo(kp[a][0] * w, kp[a][1] * h);
    ctx.lineTo(kp[b][0] * w, kp[b][1] * h);
    ctx.stroke();
  }
  kp.forEach(([x, y, c], i) => {
    if (c < 0.3) return;
    const hot = highlight.includes(NAMES[i]);
    ctx.beginPath();
    ctx.arc(x * w, y * h, (hot ? 9 : 4.5) * devicePixelRatio, 0, Math.PI * 2);
    ctx.fillStyle = hot ? '#ffd34d' : '#ffffff';
    ctx.fill();
  });
}

// ---------------------------------------------------------------- 機器人

async function send(body) {
  try {
    const res = await fetch('/api/robot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: '連不到辨識服務' };
  }
}

/**
 * 叫機器人做事。上課時是模擬機器人（只顯示在網頁上）；接上平台時，真的機器人會照做。
 * 同一個動作 0.8 秒內只能叫一次，太頻繁會被擋下來（回傳 {ok: false}）。
 *   robot.expression('happy')   換表情：只能用 robot_actions.json 的 expressions 清單裡的
 *   robot.show('做得好！')       在機器人螢幕上顯示大字（給重聽的長輩看）
 */
export const robot = {
  say: (text) => send({ action: 'say', text }),
  nod: () => send({ action: 'nod' }),
  skill: (name) => send({ action: 'skill', name }),
  expression: (name) => send({ action: 'expression', name }),
  show: (text) => send({ action: 'show', text }),
};
