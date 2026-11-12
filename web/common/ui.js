// ui.js：每個遊戲頁都一樣的部分（頁首的狀態燈、機器人對話框、語音）。遊戲不用改這個檔案。
import { mountVoice, voice } from './voice.js';

const $ = (sel, root = document) => root.querySelector(sel);

/** 頁首：返回大廳、遊戲名稱、狀態燈。回傳一個物件，在 connect() 的事件裡呼叫它 */
export function mountTopbar(title) {
  document.title = title;
  const bar = document.createElement('header');
  bar.className = 'topbar';
  bar.innerHTML = `
    <a class="back" href="/">← 大廳</a>
    <h1></h1>
    <div class="chips">
      <span class="chip" data-k="conn">連線中…</span>
      <span class="chip" data-k="fps">— 張/秒</span>
      <span class="chip" data-k="src">影像</span>
      <span class="chip" data-k="robot">機器人</span>
    </div>`;
  $('h1', bar).textContent = title;
  document.body.prepend(bar);
  mountVoice();                               // 左下角的麥克風按鈕：用說的操作（見 voice.js）
  const chip = (k, text, state) => {
    const el = $(`[data-k="${k}"]`, bar);
    el.textContent = text;
    el.className = 'chip ' + (state || '');
  };
  let lastFps = 0;
  return {
    status(connected) { chip('conn', connected ? '已連線' : '連線中斷，重連中…', connected ? 'ok' : 'bad'); },
    hello(msg) {
      chip('src', msg.source, msg.source_kind === 'demo' ? 'warn' : 'ok');
      chip('robot', msg.robot_mode === 'mock' ? '模擬機器人' : msg.robot, msg.robot_mode === 'mock' ? '' : 'ok');
    },
    pose(msg) {
      const now = performance.now();
      if (now - lastFps < 500) return;        // 半秒更新一次就好
      lastFps = now;
      chip('fps', `${msg.fps.toFixed(0)} 張/秒`, msg.fps >= 12 ? 'ok' : 'warn');
    },
  };
}

/** 機器人對話框：放在 element 裡，onRobot 收到訊息時呼叫 show(msg) */
export function mountRobot(element) {
  element.innerHTML = `<div class="robot"><div class="face">🤖</div><div class="bubble muted">機器人在這裡等你。</div></div>`;
  const face = $('.face', element);
  const bubble = $('.bubble', element);
  return {
    show(msg) {
      bubble.className = 'bubble' + (msg.ok ? '' : ' err');
      bubble.textContent = msg.ok ? msg.result : msg.error;
      face.classList.remove('talk');
      void face.offsetWidth;                  // 重新觸發動畫
      if (msg.ok) face.classList.add('talk');
      if (msg.ok && msg.action === 'say') voice.robotSaid(msg.text);   // 機器人說的話用喇叭唸出來
    },
  };
}
