// 範本遊戲：雙手舉高、再放下，算一次。每 5 次機器人說一句話。
//
// 做自己的遊戲：
//   1. 複製整個 _template 資料夾，改成你的名字（例如 squat-counter）。資料夾名稱用英文、不要空白
//   2. 改 game.json 的 title、description、icon、author，大廳就會出現你的遊戲
//   3. 改下面的 onPose：判斷動作、計分
//   存檔後，在瀏覽器按 F5 重新整理就看得到，不用重開伺服器
import { connect, createStage, point, isHandUp, mainPerson, Hold, robot } from '/common/pose.js';
import { mountTopbar, mountRobot } from '/common/ui.js';

const $ = (id) => document.getElementById(id);
const topbar = mountTopbar('我的遊戲');          // TODO：改成你的遊戲名稱
const robotBox = mountRobot($('robot'));
const stage = createStage($('stage'));

let count = 0;
let up = false;                 // 現在是不是「舉著」的狀態
const holdUp = new Hold(300);   // 舉高要維持 0.3 秒才算（避免辨識跳動）

function onPose(people, msg) {
  topbar.pose(msg);
  stage.draw(people, { highlight: ['left_wrist', 'right_wrist'] });

  const person = mainPerson(people);       // 畫面裡最大的那個人
  if (!person) {
    $('debug').textContent = '畫面裡沒有人';
    return;
  }

  // 除錯：看看關節的數字（y 越小越高）
  const lw = point(person, 'left_wrist');
  const rw = point(person, 'right_wrist');
  $('debug').textContent =
    `左手腕 ${lw ? `x=${lw.x.toFixed(2)} y=${lw.y.toFixed(2)}` : '看不到'}　` +
    `右手腕 ${rw ? `x=${rw.x.toFixed(2)} y=${rw.y.toFixed(2)}` : '看不到'}`;

  // TODO：把這段改成你的遊戲規則
  const bothUp = isHandUp(person, 'left') && isHandUp(person, 'right');
  if (!up && holdUp.update(bothUp)) {
    up = true;                              // 舉起來了
  } else if (up && !bothUp) {
    up = false;                             // 放下來了 → 算一次
    count += 1;
    $('count').textContent = String(count);
    $('big').textContent = String(count);
    setTimeout(() => { $('big').textContent = ''; }, 600);
    if (count % 5 === 0) robot.say(`做了 ${count} 次，繼續加油！`);
  }
}

$('reset').onclick = () => {
  count = 0;
  $('count').textContent = '0';
  robot.nod();
};

connect({
  onPose,
  onHello: (msg) => topbar.hello(msg),
  onStatus: (connected) => topbar.status(connected),
  onRobot: (msg) => robotBox.show(msg),
});
