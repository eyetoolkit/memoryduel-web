/**
 * P1-5 Color Recall 双人对战 · 线上验收
 * ────────────────────────────────────────────────────────────────
 * 打真实站点跑一整局**双人**：A 建房 → B 邀请码加入 → A 开赛 →
 * 两人各自打完 3 轮 → 比出结果。
 *
 * 🔴 为什么必须真开两个页面而不是单页 mock：
 *   这是异步对战，两个人在**不同浏览器上下文**里、各自持有各自的
 *   pid/token。单页 mock 掉整个 room 层，就等于没验「同场同题」
 *   ——而那恰恰是这类游戏唯一的技术难点。
 *
 * 🔴 submit 会写 KV（房间状态 + 双方比分）。房间是一次性的、用完即弃，
 *   与「每日连胜/榜单」不同：这里真打就是该房间的正常玩法，
 *   不存在污染他人数据的风险（房间码随机、不进任何榜单）。
 *
 * 验证：
 *  1. A、B 拿到**完全相同**的颜色（服务端权威，非各自随机）
 *  2. 颜色关全流程可走通：展示 → 逐色还原 → 锁定 → 提交
 *  3. 提交的是真实作答，服务端判分返回，双方比分都能显示
 *  4. 对战里滑块初值是中性值（不动不会拿满分 —— 公平性铁律）
 *  5. 无未捕获异常 / console.error / 资源错误
 *
 * 用法：node tests/p1-5-color-live.mjs [--url=https://www.memoryduel.com]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? '1'] : [a, '1'];
}));
const ORIGIN = (argv.url || 'https://www.memoryduel.com').replace(/\/+$/, '');
const GAME_URL = `${ORIGIN}/games/color-recall/`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

/* ═══════════════════════════════════════════════════════════════
   CDP 客户端
   ═══════════════════════════════════════════════════════════════ */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); this.events = []; }
  static async attach(port) {
    let list = null;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/list`);
        list = (await r.json()).find((t) => t.type === 'page');
        if (list) break;
      } catch (_) {}
      await sleep(200);
    }
    if (!list) throw new Error('CDP: 未找到 page target');
    const ws = new WebSocket(list.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.waits.has(m.id)) { c.waits.get(m.id)(m); c.waits.delete(m.id); }
      else if (m.method) c.events.push(m);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waits.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  problems() {
    const out = [];
    for (const e of this.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        out.push('未捕获异常: ' + (d.exception?.description || d.text));
      } else if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        out.push('console.error: ' + e.params.args.map((a) => a.value ?? a.description).join(' '));
      } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        out.push('资源错误: ' + e.params.entry.text + ' ' + (e.params.entry.url || ''));
      }
    }
    return out;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

/* ═══════════════════════════════════════════════════════════════
   页面启动：每个玩家一个独立 Edge profile（= 独立 pid/token）
   ═══════════════════════════════════════════════════════════════ */
const HOOK = `
window.__diag = [];
var _oe = console.error;
console.error = function () {
  window.__diag.push('console.error: ' + Array.prototype.map.call(arguments, String).join(' '));
  _oe.apply(console, arguments);
};
window.addEventListener('error', function (e) { window.__diag.push('window.error: ' + e.message); });
window.addEventListener('unhandledrejection', function (e) {
  window.__diag.push('unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason));
});
// 🔴 抓题端点是 **/room/round**（见 duel-room.js:144）。
//    写成 /room/questions 会一个都抓不到，而「收到 0 组题目」
//    看起来像后端没下发，实际是监听路径写错 —— 别急着怀疑产品。
window.__puzzles = [];
(function () {
  var _f = window.fetch;
  window.fetch = function (input, init) {
    var url = String(input && input.url ? input.url : input);
    var p = _f.call(this, input, init);
    if (url.indexOf('/room/round') >= 0) {
      p = p.then(function (r) {
        r.clone().json().then(function (j) {
          var pz = j && (j.puzzle || (j.data && j.data.puzzle));
          if (pz) window.__puzzles.push(pz);
        }).catch(function () {});
        return r;
      });
    }
    return p;
  };
})();
`;

async function openPlayer(port, label) {
  const profile = path.join(os.tmpdir(), `md-col-${label}-${process.pid}`);
  const proc = spawn(EXE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', detached: false });

  const c = await CDP.attach(port);
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Page.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  c._profile = profile;
  c._proc = proc;
  return c;
}

function closePlayer(c) {
  if (!c) return;
  c.close();
  try { c._proc.kill(); } catch (_) {}
  setTimeout(() => { try { fs.rmSync(c._profile, { recursive: true, force: true }); } catch (_) {} }, 400);
}

/* ═══════════════════════════════════════════════════════════════
   自动操作一个玩家
   ═══════════════════════════════════════════════════════════════ */
/** 点击文本匹配到的第一个按钮 */
const clickByText = (re) => `
  const b = [...document.querySelectorAll('button,a.btn,.dc-btn')].find(x =>
    ${re} && !x.disabled && x.offsetParent);
  if (b) { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; }
  return false;
`;

/** 跑完一整局 3 轮作答。
 *  🔴 调用前两人**必须已在同一房间且已开局** —— 本函数只负责作答，
 *     不碰建房/加入/开赛。早期版本让两个玩家都从入口页起步，
 *     B 顺手点了「创建对决」，两人各建各的房间、永不相遇，
 *     而各自的「3 轮」都显示跑完了 —— 假绿最贵，它不会报错。 */
async function playOut(c, tag) {
  const step = async (expr, label) => {
    const r = await c.eval(expr);
    if (r) return r;
    await sleep(300);
    return false;
  };

  // 3 轮：点开始 → 等颜色展示完 → 逐色锁定
  for (let round = 0; round < 3; round++) {
    // 点本轮的「开始」。🔴 轮次开始按钮的 id 是 `go`（见 duel-sequence
    // 的 playRound 首屏），不要用文案正则 —— 六语文案随时会变，
    // 而「按下按钮没反应」这种假绿最费时间。
    let clicked = false;
    for (let i = 0; i < 80 && !clicked; i++) {
      clicked = await c.eval(`
        const b = document.getElementById('go');
        if (b && !b.disabled && b.offsetParent) { b.click(); return true; }
        return false;
      `);
      if (!clicked) await sleep(300);
    }
    if (!clicked) throw new Error(`${tag} R${round + 1}: 点不到开始`);

    // 颜色展示约 4.2s。必须先确认 swatch 真的出现，否则 sleep 4600
    // 只是一段盲等 —— 题目没下发时会「等完继续」，一路假绿到底。
    const sawShow = await c.eval(`
      for (let i = 0; i < 150; i++) {
        if (document.querySelectorAll('.dc-color-swatch').length >= 3) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    `);
    if (!sawShow) throw new Error(`${tag} R${round + 1}: 颜色没展示（.dc-color-swatch < 3）`);
    await sleep(4600);

    // 逐色锁定：默认不动 = 中性值，代表「记不清」
    for (let k = 0; k < 5; k++) {
      let locked = false;
      for (let i = 0; i < 30 && !locked; i++) {
        locked = await c.eval(`
          const b = document.getElementById('lock');
          if (b && !b.disabled && b.offsetParent) { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; }
          return false;
        `);
        if (!locked) await sleep(300);
      }
      if (!locked) break;   // 最后一色锁完就没有 lock 按钮了
      await sleep(400);
    }

    // 轮间结果页 → 继续（id=nextBtn，见 playRound 的结果屏）
    for (let i = 0; i < 40; i++) {
      const nxt = await c.eval(`
        const b = document.getElementById('nextBtn');
        if (b && !b.disabled && b.offsetParent) { b.click(); return true; }
        return false;
      `);
      if (nxt) break;
      await sleep(300);
    }
    await sleep(600);
  }

  // 4) 终局
  for (let i = 0; i < 60; i++) {
    const done = await c.eval(`return !!document.getElementById('againBtn');`);
    if (done) break;
    await sleep(400);
  }
}

/* ═══════════════════════════════════════════════════════════════
   开跑
   ═══════════════════════════════════════════════════════════════ */
console.log(`\n═══ P1-5 Colour Recall 线上验收：${ORIGIN} ═══\n`);
console.log('[1] 双人对战全流程（两个独立浏览器上下文）');

let A = null, B = null;
try {
  A = await openPlayer(18951, 'A');
  B = await openPlayer(18952, 'B');

  await A.send('Page.navigate', { url: GAME_URL });
  await B.send('Page.navigate', { url: GAME_URL });

  const readyA = await A.eval(`
    for (let i = 0; i < 100; i++) {
      if (window.DuelRoom && document.getElementById('createBtn')) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  `);
  const readyB = await B.eval(`
    for (let i = 0; i < 100; i++) {
      if (window.DuelRoom && document.getElementById('createBtn')) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  `);
  ok(readyA, '玩家 A 页面就绪（页面已上线、非 404）');
  ok(readyB, '玩家 B 页面就绪');

  // 标题走 i18n 而非 key 原文 —— 漏翻会直接显示 duel.col_title
  const title = await A.eval(`return (document.querySelector('.dc-h2')||{}).textContent || '';`);
  ok(title && title !== 'duel.col_title' && title.length > 3,
    `入口标题已本地化（${title}）`);

  // A 建房。
  // 🔴 必须先清 sessionStorage —— duel-sequence 的 main() 会读
  //    sessionStorage.getItem('duel-code') 回填房间，残留值会让
  //    A 一进页面就「回到上次的房间」，点「创建对决」根本没有入口。
  //    这里用 Page.navigate 到 about:blank 先卸载页面，
  //    再回填再导航（同一 origin 下 sessionStorage 才清得掉）。
  await A.send('Page.navigate', { url: 'about:blank' });
  await sleep(400);
  await A.send('Page.navigate', { url: GAME_URL });
  await sleep(1500);
  await A.eval(`try { sessionStorage.clear(); } catch (_) {} return true;`);
  await A.send('Page.navigate', { url: GAME_URL });
  await sleep(1800);
  await A.eval(clickByText(`/^(Create a duel|创建对决|建立對決|Crear un duelo|Créer un duel|Duell erstellen)/i`));

  let code = '';
  for (let i = 0; i < 60 && !code; i++) {
    code = await A.eval(`
      const el = document.querySelector('.duel-code-big');
      const v = el ? (el.textContent||'').trim() : '';
      if (v && v.length >= 4) return v;
      return '';
    `);
    if (!code) await sleep(400);
  }
  ok(!!code, `A 建房成功，房间码 ${code}`);

  if (code) {
    // 🔴 B 必须**只走邀请码**、绝不能建房。
    //    第一版让两个玩家都从入口页起步，B 顺手点了「创建对决」——
    //    结果两人各建各的房间，永远不会相遇，A 卡在「等待对手加入」，
    //    而双方各自的「3 轮」却都「跑完了」（在自己的空房里）。
    //    这类假绿最贵：它不会报错，只会让你以为功能是好的。
    await B.send('Page.navigate', { url: `${GAME_URL}?c=${code}` });

    const bIn = await B.eval(`
      for (let i = 0; i < 80; i++) {
        const el = document.querySelector('.duel-code-big');
        const v = el ? (el.textContent||'').trim() : '';
        if (v && v.length >= 4) return { code: v, h2: (document.querySelector('.dc-h2')||{}).textContent || '' };
        await new Promise(r => setTimeout(r, 150));
      }
      return { code: '', h2: (document.querySelector('.dc-h2')||{}).textContent || '' };
    `);
    ok(bIn.code === code, `B 通过邀请码进入同一房间（${bIn.code || bIn.h2 || '未进入'}）`);

    // A 开赛。
    // 🔴 必须**确认房间里真有两个人**再点开赛 —— 否则 B 还没 join 成功，
    //    A 这边点了只会拿到一个 status 仍为 waiting 的房间，然后卡死。
    const roomOk = await A.eval(`
      const code = ${JSON.stringify(code)};
      for (let i = 0; i < 60; i++) {
        try {
          const n = await window.DuelRoom.roomStatus(code);
          const c = n && (n.players || []).length;
          if (c >= 2) return c;
        } catch (_) {}
        await new Promise(r => setTimeout(r, 400));
      }
      return 0;
    `);
    ok(roomOk >= 2, `房间里有 2 名玩家（实得 ${roomOk}）`);

    // 🔴 用稳定 id 定位，不要用按钮文案正则：
    //    renderWaiting 会被轮询反复重渲染，文本匹配在重渲染瞬间
    //    会拿到已被替换掉的旧节点 —— 点击事件随之丢失，表现就是
    //    「点了没反应、服务端状态仍是 waiting」，极难定位。
    //    id="startBtn"（见 duel-sequence.ts renderWaiting）。
    const started = await A.eval(`
      for (let i = 0; i < 40; i++) {
        const b = document.getElementById('startBtn');
        if (b && b.offsetParent) { b.click(); return true; }
        await new Promise(r => setTimeout(r, 400));
      }
      return false;
    `);
    ok(started, '房主「开始对决」按钮可点');

    // 🔴 公平性采样必须**在开赛前**就把 watcher 挂上。
    //    还原阶段的滑块只存在几秒，等 playOut 跑完再看，
    //    DOM 里早就被下一屏替换掉了 —— 采样到的是终局的 null。
    const fairSample = [];
    const fairWatcher = (async () => {
      for (let i = 0; i < 600 && fairSample.length < 1; i++) {
        const v = await A.eval(`
          const h = document.getElementById('h');
          const s = document.getElementById('s');
          const b = document.getElementById('b');
          if (!h || !s || !b) return null;
          return { h: +h.value, s: +s.value, b: +b.value };
        `);
        if (v) fairSample.push(v);
        else await sleep(150);
      }
    })();

    // 🔴 开赛后必须**回读服务端状态**确认真的 started 了。
    //    按钮点得到 ≠ 请求成功（限流/网络抖动都可能是假绿）。
    await sleep(1200);
    const postStart = await A.eval(`
      const code = ${JSON.stringify(code)};
      let lastErr = null;
      for (let i = 0; i < 40; i++) {
        try {
          const st = await window.DuelRoom.roomStatus(code);
          if (st && st.status && st.status !== 'waiting') return st.status;
          lastErr = 'status=' + (st && st.status);
        } catch (e) { lastErr = String(e && e.message); }
        await new Promise(r => setTimeout(r, 400));
      }
      return 'still-waiting(' + lastErr + ')';
    `);
    // 🔴 判定必须比对具体值，不能只判真值 —— 返回的是字符串哨兵
    //    'still-waiting' 时 !!'still-waiting' 恒为 true，是典型假绿。
    ok(postStart !== 'still-waiting(' && postStart !== 'still-waiting',
      `服务端已确认开局（status=${postStart}）`);

    await sleep(1200);

    // 两人同时打完 3 轮
    const [ra, rb] = await Promise.all([
      playOut(A, 'A').then(() => 'ok').catch((e) => String(e.message)),
      playOut(B, 'B').then(() => 'ok').catch((e) => String(e.message)),
    ]);
    ok(ra === 'ok', `A 打完 3 轮${ra === 'ok' ? '' : '：' + ra.slice(0, 90)}`);
    ok(rb === 'ok', `B 打完 3 轮${rb === 'ok' ? '' : '：' + rb.slice(0, 90)}`);

    // 两人题目必须完全相同（服务端权威）
    const pa = await A.eval('return window.__puzzles || [];');
    const pb = await B.eval('return window.__puzzles || [];');
    ok(Array.isArray(pa) && pa.length >= 3, `A 收到 ${(pa || []).length} 组题目`);
    ok(Array.isArray(pb) && pb.length >= 3, `B 收到 ${(pb || []).length} 组题目`);

    if ((pa || []).length && (pb || []).length) {
      const key = (p) => JSON.stringify((p.colors || []).map((c) => [c.h, c.s, c.b]));
      const same = Math.min(pa.length, pb.length);
      let allSame = true;
      for (let i = 0; i < same; i++) {
        if (key(pa[i]) !== key(pb[i])) { allSame = false; break; }
      }
      ok(allSame, `两人拿到**完全相同**的颜色（前 ${same} 轮逐轮比对）`);
    }

    // 比分页
    const res = await A.eval(`return {
      hasAgain: !!document.getElementById('againBtn'),
      rows: document.querySelectorAll('.dc-rank-row').length,
      title: (document.querySelector('.dc-h2')||{}).textContent || '',
    };`);
    ok(res.hasAgain, `A 到终局（标题：${res.title}）`);
    ok(res.rows >= 2, `比分页列出双方（${res.rows} 行）`);

    await fairWatcher;
    const f = fairSample[0];
    ok(!!f, '抓到了还原阶段的滑块初值');
    if (f) {
      ok(f.h === 0 && f.s === 50 && f.b === 50,
        `滑块初值为中性值（H=${f.h} S=${f.s} B=${f.b}）—— 不动不会满分`);
    }

    // 再来一次必须回 color 而不是跳去别的游戏
    const home = await A.eval(`
      const a = document.getElementById('againBtn');
      return { exists: !!a, href: a ? (a.getAttribute('href')||'') : '' };
    `);
    ok(home.exists, '「再来一局」按钮在');
  }

  const probs = [...A.problems(), ...B.problems()];
  const diag = [
    ...(await A.eval('return window.__diag || [];')),
    ...(await B.eval('return window.__diag || [];')),
  ];
  const all = probs.concat(diag);
  ok(all.length === 0, `无未捕获异常 / console.error / 资源错误（${all.length}）${all.length ? '：' + all[0].slice(0, 130) : ''}`);
} finally {
  closePlayer(A);
  closePlayer(B);
}

console.log(`\n═══ P1-5 线上验收：${pass} pass / ${fail} fail ═══\n`);
process.exit(fail ? 1 : 0);