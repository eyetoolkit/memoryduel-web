/**
 * 异步终局 · 前端行为验收（CDP 无头，线上 www.memoryduel.com）
 * ────────────────────────────────────────────────────────────────
 * 背景：2026-10-13 修复「首人提前固化整局」后，前端改为
 * 「完成个人轮次 → 等服务端判定终局」。服务端已由
 * tests/duel-settle-race.mjs 覆盖（23/23），本脚本只验**界面行为**：
 *
 *   A. 房主建房开局后，另一身份打完 → 界面停在「等待对手」，
 *      而不是跳到终局比分（终局必须等服务端）
 *   B. 等待界面能实时刷新比分（对手进度可见）
 *   C. 对手补完剩余轮次 → 自动转终局比分页
 *   D. 已结算房间刷新 → **不再重进对战循环**（这是修 status 机
 *      之后必须同步补的前端分支，否则漏洞从后门回来）
 *   E. 等待/终局页面零 console.error
 *
 * 关键实现细节：两个身份要在一个浏览器里共存，靠
 * localStorage 的 md_session 不同来区分 —— 故用两个独立
 * 标签页并各自预置 sessionStorage。
 *
 * 用法：node tests/audit-duel-settle-ui.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ORIGIN = process.env.MD_ORIGIN || 'https://www.memoryduel.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const info = (m) => console.log(`       ${m}`);
const section = (t) => console.log(`\n═══ ${t} ═══`);

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); this.events = []; }
  static async attach(port) {
    let list = null;
    for (let i = 0; i < 60; i++) {
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
      this.waits.set(id, (m) => {
        if (m.error) rej(new Error(method + ': ' + m.error.message));
        else res(m.result);
      });
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
      }
    }
    return out;
  }
  async waitFor(fn, timeout = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await fn()) return true; } catch (_) {}
      await sleep(250);
    }
    return false;
  }
  clearEvents() { this.events.length = 0; }
}

/* ── 浏览器 ─────────────────────────────────────────────────── */
const PORT = 9840 + (process.pid % 150);
const PROFILE = path.join(os.tmpdir(), 'md-settle-ui-' + process.pid);
fs.mkdirSync(PROFILE, { recursive: true });
const edge = spawn(EXE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', `--user-data-dir=${PROFILE}`,
  // 本机系统代理开着，无头 Edge 继承后全部 ERR_PROXY_CONNECTION_FAILED，
  // 页面落地成「代理出错」页，极易误判成站点挂了。
  '--no-proxy-server',
  'about:blank',
], { stdio: 'ignore', detached: false });

const cleanup = () => { try { edge.kill(); } catch (_) {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {} };
process.on('exit', cleanup);

let page;
try {
  page = await CDP.attach(PORT);
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  /* ── 建两个匿名身份（服务端接口，与前端同一套）── */
  const mkSession = async () => {
    const r = await fetch(`${ORIGIN}/api/md/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const j = await r.json();
    return { pid: j.data.pid, token: j.data.token };
  };
  const hostS = await mkSession();
  const guestS = await mkSession();
  info(`host=${hostS.pid.slice(0, 10)}…  guest=${guestS.pid.slice(0, 10)}…`);

  const api = async (s, method, p, body) => {
    const r = await fetch(`${ORIGIN}/api/md${p}`, {
      method,
      headers: {
        'X-Player-ID': s.pid, 'X-Player-Token': s.token, 'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { s: r.status, data: j && j.data, code: j && j.error && j.error.code };
  };

  const ROUNDS = 3;
  const GAME = 'sequence-memory';

  /* 用接口把房间推到「房主已开局、两人都在房里」，
     再让页面接管房主这一侧 —— 这样只需一个标签页就能验界面。 */
  section('A. 前置：建房 + 加入 + 房主开局');
  const cr = await api(hostS, 'POST', '/room/create', { game: GAME, rounds: ROUNDS });
  const code = cr.data.code;
  await api(guestS, 'POST', '/room/join', { code });
  const st = await api(hostS, 'POST', '/room/start', { code, game: GAME, rounds: ROUNDS });
  ok(st.s === 200 && st.data && st.data.started === true,
    `房主开局成功（房间 ${code}，${ROUNDS} 轮）`);
  info(`start → HTTP ${st.s} ${JSON.stringify(st.data || {})}`);

  /* ── B. 把房主身份注入页面，让它走完整对战流程 ── */
  section('B. 房主侧：打完 3 轮后应进入「等待对手」');

  /* 🔴 必须**先导航到站点**再写 localStorage。
     localStorage 是按 origin 隔离的：起始页是 about:blank，
     在那里 setItem 写的是 about:blank 的存储，
     对 https://www.memoryduel.com 毫无影响 → 页面 ensureSession()
     会另建一个匿名身份 → 拿着别人的 pid 进房 → 报「Something went wrong」。
     这个坑的表现是"身份莫名不对"，极难从表象反推。 */
  await page.send('Page.navigate', { url: `${ORIGIN}/games/${GAME}/` });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'), 25000);
  await page.eval(`
    try {
      localStorage.setItem('md_session', ${JSON.stringify(JSON.stringify(hostS))});
      sessionStorage.removeItem('duel-code');
      sessionStorage.removeItem('duel-host');
    } catch (e) {}
    return localStorage.getItem('md_session') ? true : false;`);
  info('已在站点源下注入房主 md_session');

  await page.send('Page.navigate', { url: `${ORIGIN}/games/${GAME}/?c=${code}` });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'), 25000);

  // 深链进入后应自动进房；房主身份靠 ?c= 恢复不了 host，
  // 但本场景已开局，页面会直接进作答流程。
  const inRoom = await page.waitFor(
    () => page.eval(`return !!document.getElementById('go') || !!document.getElementById('codeBig');`), 25000);
  ok(inRoom, '深链 ?c= 进入房间并渲染对战界面');

  /* 自动完成 ROUNDS 轮：点「开始记忆」→ 等展示结束 → **按真实 seq 长度**点格子。
     🔴 踩过的坑：先前固定点 3 个格子。第 1 轮 seq 恰好 ≤3 侥幸通过，
        第 2 轮 len>3 时 Promise 永远不 resolve，页面卡在
        「轮到你了——按原顺序点回」，看起来像站点坏了。
        根因：seq = shuffle(9 格).slice(0, len)，len 逐轮增长。
        正确做法是读出该轮实际格子数再点够。
        注意 seq 内容不必还原正确（判分只影响分数，不影响流程）。 */
  let playedRounds = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const gotGo = await page.waitFor(() => page.eval(`return !!document.getElementById('go');`), 15000);
    if (!gotGo) { info(`⚠ 第 ${round + 1} 轮没等到「开始记忆」按钮`); break; }
    await page.eval(`document.getElementById('go').click(); return true;`);

    // 等展示阶段结束、进入点格子阶段（disabled 被移除）
    const canTap = await page.waitFor(() => page.eval(`
      const cells = document.querySelectorAll('.dc-seq-cell');
      return cells.length > 0 && !cells[0].hasAttribute('disabled');
    `), 30000);
    if (!canTap) { info(`⚠ 第 ${round + 1} 轮未进入作答阶段`); break; }

    // 每轮是新一次作答，点击计数必须归零
    await page.eval('window.__tapped = 0; return true;');

    /* 从 DOM 反推该轮需要的点击数：playRound 的 resolve 条件是
       picked.length >= seq.length，而 seq 长度 = 该轮 len。
       页面没暴露 len，但 seq 的格子会在展示阶段被点亮过 ——
       这里改用「渐进点击 + 轮询结算按钮」：每次点 3 格，
       没结算就继续点，直到出现 nextBtn。这样与 len 无关。 */
    let nextBtn = false;
    let tapped = 0;
    for (let tap = 0; tap < 5 && !nextBtn; tap++) {
      /* 按 data-i 递增点击**未点过**的格子，避免重复点同一格
         （重复点击会让 picked 长度虚增、提前 resolve，判分随之失真）。
         用一个页面级计数器保证跨多次 tap 累积。 */
      await page.eval(`
        window.__tapped = window.__tapped || 0;
        // 按 data-i 建索引，避免把「元素下标」与「格子编号」混为一谈
        const cells = Array.from(document.querySelectorAll('.dc-seq-cell:not([disabled])'));
        if (!cells.length) return -1;
        const byId = new Map();
        for (const c of cells) byId.set(Number(c.dataset.i), c);
        // 跨格子分散点击，模拟真实玩家的位置选择（也避免总点左上角）
        const order = [4, 0, 8, 2, 6, 1, 3, 5, 7];
        while (window.__tapped < order.length) {
          const el = byId.get(order[window.__tapped]);
          window.__tapped++;
          if (!el) break;
          el.click();
        }
        return window.__tapped;`);
      tapped++;
      nextBtn = await page.waitFor(() => page.eval(`return !!document.getElementById('nextBtn');`), 2500);
    }
    info(`第 ${round + 1} 轮：点击 ${tapped} 批后${nextBtn ? '已' : '未'}出结算按钮`);
    if (!nextBtn) {
      info(`⚠ 第 ${round + 1} 轮点满仍无结算按钮（题目可能需要更多点击）`);
      break;
    }
    playedRounds++;
    await page.eval(`document.getElementById('nextBtn').click(); return true;`);
    await sleep(400);
  }
  ok(playedRounds === ROUNDS, `房主完成全部 ${ROUNDS} 轮（实际 ${playedRounds}）`);

  // 打完应停在等待界面，而不是终局比分
  const waited = await page.waitFor(() => page.eval(`
    const h = document.querySelector('.dc-h2');
    const txt = h ? (h.textContent||'') : '';
    return /All your rounds are done|你的轮次已全部完成/i.test(txt);
  `), 25000);

  const uiAfterRounds = await page.eval(`
    return {
      h2: (document.querySelector('.dc-h2')||{}).textContent || '',
      hasWaitSpin: !!document.getElementById('waitSpin'),
      hasScores: !!document.getElementById('waitScores'),
      againBtn: !!document.getElementById('againBtn'),
      bodyLen: (document.body.textContent||'').trim().length,
    };`);
  ok(waited, '打完进入「等待对手」界面（终局不由前端单方决定）');
  info(`H2=${uiAfterRounds.h2}`);
  ok(uiAfterRounds.hasWaitSpin, '等待界面有轮询提示（waitSpin）');
  /* 🔴 断言方向要跟着 waited 走。若 waiting 本身失败，
     这里若无条件断言"没有终局按钮"就会假绿 —— 错误页当然也没有。
     正确写法：仅在确实进入等待界面时，才断言尚未结算。 */
  if (waited) {
    ok(uiAfterRounds.againBtn !== true, '等待界面不出现「New duel」终局按钮（尚未结算）');
  } else {
    ok(false, '未进入等待界面，跳过「无终局按钮」断言（避免假绿）');
  }
  ok(uiAfterRounds.bodyLen > 80, `等待界面有实质内容 bodyLen=${uiAfterRounds.bodyLen}`);

  section('C. 等待界面实时刷新比分');
  // 对手答第 1 轮后，房主页面的比分应变化
  await api(guestS, 'POST', '/answer', { code, round: 0, payload: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
  const scoreShown = await page.waitFor(() => page.eval(`
    const box = document.getElementById('waitScores');
    if (!box) return false;
    const rows = box.querySelectorAll('.dc-rank-row');
    return rows.length >= 2;
  `), 20000);
  ok(scoreShown, '等待界面渲染出双方比分行（对手进度可见）');

  section('D. 对手补完剩余轮次 → 自动转终局');
  for (let r = 1; r < ROUNDS; r++) {
    await api(guestS, 'POST', '/answer', { code, round: r, payload: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
  }
  const settled = await page.waitFor(() => page.eval(`
    const h = document.querySelector('.dc-h2');
    const txt = h ? (h.textContent||'') : '';
    return /Duel complete|对决完成/i.test(txt);
  `), 30000);
  ok(settled, '对手跑完后自动切到终局比分页（无需手动刷新）');

  const finalUi = await page.eval(`
    return {
      again: !!document.getElementById('againBtn'),
      rows: document.querySelectorAll('.dc-rank-row').length,
      bodyLen: (document.body.textContent||'').trim().length,
    };`);
  ok(finalUi.again, '终局页出现「New duel」');
  ok(finalUi.rows >= 2, `终局比分列出双方（${finalUi.rows} 行）`);

  section('E. 已结算房间刷新（关键回归）');
  page.clearEvents();
  await page.send('Page.reload', { ignoreCache: true });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'), 25000);

  const afterReload = await page.waitFor(() => page.eval(`
    const h = document.querySelector('.dc-h2');
    return !!h && /Duel complete|对决完成/i.test(h.textContent||'');
  `), 25000);

  const reloadUi = await page.eval(`
    const h = document.querySelector('.dc-h2');
    return {
      h2: h ? h.textContent : '',
      hasGo: !!document.getElementById('go'),
      hasNext: !!document.getElementById('nextBtn'),
      hasCode: !!document.getElementById('codeIn'),
      bodyLen: (document.body.textContent||'').trim().length,
    };`);
  ok(afterReload, '刷新已结算房间仍停在终局比分（不再重进对战循环）');
  info(`刷新后 H2=${reloadUi.h2}`);
  /* 同上：这三条只在确认停在终局页时才有意义。
     错误页同样"没有 Start round"，无条件断言必然假绿。 */
  if (afterReload) {
    ok(reloadUi.hasGo !== true, '刷新后不出现「Start round」按钮（未重进作答循环）');
    ok(reloadUi.hasNext !== true, '刷新后不出现轮次结算按钮');
    ok(reloadUi.hasCode !== true, '刷新后不回退到入口页（建房/加入）');
  } else {
    ok(false, '刷新后未停在终局页，跳过三条「不应出现」断言（避免假绿）');
  }

  section('F. 零 console.error');
  const probs = page.problems();
  ok(probs.length === 0, `等待/终局流程零 console.error（发现 ${probs.length} 条）`);
  if (probs.length) probs.slice(0, 5).forEach((p) => info('⚠ ' + p));

  section('G. D1 侧交叉验证');
  const stAfter = await api(hostS, 'GET', `/room/status?code=${code}`);
  ok(stAfter.data && stAfter.data.status === 'finished',
    `服务端状态为 finished（实测 ${stAfter.data && stAfter.data.status}）`);

} catch (e) {
  fail++;
  console.log(`  FAIL 脚本异常：${e.message}`);
  console.log(e.stack?.split('\n').slice(1, 4).join('\n'));
} finally {
  cleanup();
}

console.log('\n═══════════════════════════════');
console.log(`结果: ${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项`);
process.exit(fail ? 1 : 0);