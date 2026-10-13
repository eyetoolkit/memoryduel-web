/**
 * P1-4 分享卡 · 线上验收（memoryduel.com）
 * ────────────────────────────────────────────────────────────────
 * 与 tests/p1-4-share-cdp.mjs 的区别：那个打本地 dist + 全 mock 后端，
 * 这个打**真实线上站点**，验的是「部署结果对不对」，不是「本地代码对不对」。
 *
 * 🔴 三条红线：
 *
 * 1. 绝不能把真实答案提交给真实后端。
 *    submit 会写连胜、写榜单、用 pid 记每日最好成绩 —— 一次自动化验收
 *    就是往真实排行榜里塞一条机器生成的满分记录，污染无法回滚。
 *    所以这里只从真实后端取 today / puzzle（只读），把 submit 换成 mock。
 *
 * 2. 不能用 CDP Fetch.enable 拦。实测 Fetch.enable 之后 Page.navigate
 *    被自己发出的 requestPaused 死锁。
 *    改法：Page.addScriptToEvaluateOnNewDocument 注入 fetch 包装，
 *    **只对 submit 路径短路**，其余请求原样放行 —— 真前端、真引擎、真题。
 *
 * 3. 页面有自己的 /shared/daily-client.js，改写 window.fetch 而非替换
 *    window.DailyClient。之前用 addScript 赋值 DailyClient 会被页面
 *    自己的脚本随后覆盖，表现为「/today 响应格式异常」，极易误判成线上 bug。
 *
 * 用法：node tests/p1-4-live-verify.mjs [--url=https://www.memoryduel.com] [--card-out=路径.png]
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
const CARD_OUT = argv['card-out']
  ? String(argv['card-out'])
  : path.join(os.tmpdir(), 'md-p1-4-live-card.png');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

/* ═══════════════════════════════════════════════════════════════
   CDP 客户端（与 p1-4-share-cdp.mjs 同构）
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
  async waitFor(fn, timeout = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await fn()) return true; } catch (_) {}
      await sleep(200);
    }
    return false;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

/* ═══════════════════════════════════════════════════════════════
   注入：只短路 submit，其余真实放行
   ═══════════════════════════════════════════════════════════════ */
const TOTALS = { 'number-recall': 12, 'sequence-memory': 12, 'color-recall': 50 };
const roundMax = (g, r) => (g === 'color-recall' ? 50 : r);

/** submit 走 mock：返回与真实后端同构的报文，避免打真接口写连胜/榜单 */
const SHIM = `
(function () {
  var TOTALS = ${JSON.stringify(TOTALS)};
  var roundMax = function (g, r) { return g === 'color-recall' ? 50 : r; };
  window.__submits = [];
  var _fetch = window.fetch;
  // 🔴 硬门：submit 绝不允许走到真实网络。无论后面套几层包装、
  //    换什么调用姿势，一旦真发出去就立刻炸出来，不给「污染榜单」留缝。
  window.__realSubmitHits = 0;
  var origFetch = _fetch;
  window.fetch = function (input, init) {
    var url = String(input && input.url ? input.url : input);
    if (url.indexOf('/api/md/daily/submit') >= 0) { window.__realSubmitHits++; }
    return origFetch.call(this, input, init);
  };
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    var url = String(input && input.url ? input.url : input);
    if (url.indexOf('/api/md/daily/submit') < 0) return _fetch.call(this, input, init);

    var body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
    var g = (body && body.game) || 'unknown';
    var r = (body && body.round) || 0;
    TOTALS[g] = (TOTALS[g] || 0) + roundMax(g, r);
    window.__submits.push({ game: g, round: r, hasAnswer: !!(body && body.answer !== undefined) });

    var total = TOTALS[g];
    var max = roundMax(g, r) + (g === 'color-recall' ? 0 : 0);
    var payload = {
      ok: true,
      data: {
        game: g, round: r, correct: true,
        score: roundMax(g, r), total: total,
        maxScore: g === 'color-recall' ? 50 : 12,
        perfect: total >= (g === 'color-recall' ? 50 : 12),
        levelDone: true, allDone: true, streak: 4,
      },
    };
    return Promise.resolve(new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
  };

  // 记录真实 today 元信息（来自真后端）
  window.__liveToday = null;
  // 🔴 答案只能从 puzzle 响应体拿：数字关的 stage 展示完就被清空，
  //    等输入框解禁时 DOM 与肉眼都拿不到数字了。
  //    round 从 **1** 起（round=0 真实后端直接报 bad_round）。
  window.__mdPuzzle = null;
  window.__mdPuzzleSeq = 0;
  // 🔴 必须链在**上一层的包装**上，不能直接回落到原始 fetch：
  //    直接回落 = 绕过 submit 短路 = 真实答案被打到真实后端，
  //    一次验收就往真实连胜/榜单里塞一条机器满分记录，且不可回滚。
  var _f2 = window.fetch;
  window.fetch = function (input, init) {
    var url = String(input && input.url ? input.url : input);
    var p = _f2.call(this, input, init);
    if (url.indexOf('/api/md/daily/today') >= 0) {
      p = p.then(function (r) {
        r.clone().json().then(function (j) { if (j && j.data) window.__liveToday = j.data; }).catch(function () {});
        return r;
      });
    }
    if (url.indexOf('/api/md/daily/puzzle') >= 0) {
      p = p.then(function (r) {
        r.clone().json().then(function (j) {
          if (j && j.data && j.data.puzzle) {
            window.__mdPuzzle = j.data.puzzle;
            window.__mdPuzzleSeq++;
            window.__seqPlan = null;   // 换题重置序列关计划
            window.__colPlan = null;   // 换题重置颜色关计划
          }
        }).catch(function () {});
        return r;
      });
    }
    return p;
  };

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
})();
`;

/* ═══════════════════════════════════════════════════════════════
   自动通关
   ═══════════════════════════════════════════════════════════════ */
const AUTOPLAY_STEP = `
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  if (!window.__apSteps) window.__apSteps = [];
  const steps = window.__apSteps;
  const deadline = Date.now() + 1500;
  const pz = window.__mdPuzzle;
  const h2 = (q('.dc-h2') || {}).textContent || '';

  while (Date.now() < deadline) {
    // 🔴 终局判定用 #againBtn（稳定 id），不要用按钮文案：
    //    六语是「再玩一次 / Play again / もう一度 / Jugar otra vez / Rejouer /
    //    Nochmal spielen」，写死中英正则必漏 es/fr/de。
    const atFinal = !!document.getElementById('againBtn') && !!q('.dc-rank');
    if (q('.dc-err') || atFinal) { steps.push('final'); return steps; }

    // 🔴🔴 「开始展示 / 我准备好了」必须排在序列关**之前**。
    //    playSequence 生成的格子初始**没有** disabled 属性（disabled 是点完
    //    ready 之后才加的），而点击监听又要等演示结束才挂。
    //    先查格子 = 在没人监听的界面上空点 → picked 永远 0 → 死锁，
    //    表现为 autoplay 无限重复 seqPlan/seq 而卡死在第一关。

    // ── 颜色关：滑块默认值就是目标色，直接锁定
    const lock = document.getElementById('lock');
    if (lock && !lock.disabled) { click(lock); steps.push('lock'); await sleep(340); continue; }

    // ── 数字关：位数满即自动提交，没有提交按钮
    const ans = document.getElementById('ans');
    if (ans && !ans.disabled) {
      if (pz && pz.game === 'number-recall' && Array.isArray(pz.digits)) {
        const s = String(pz.digits.join(''));
        if (ans.value.length < s.length) {
          ans.value = ans.value + s[ans.value.length];
          ans.dispatchEvent(new Event('input', { bubbles: true }));
          steps.push('digit:' + ans.value);
          await sleep(80);
          continue;
        }
      }
      steps.push('ansStuck');
    }

    // ── 序列关：**格子解禁 且 ready 按钮已隐藏** = 演示结束、监听已挂
    //    只看 disabled 不够：ready 之前格子也是「解禁」的假象
    const cells = [...document.querySelectorAll('.dc-seq-cell')];
    if (cells.length && pz && pz.game === 'sequence-memory' && Array.isArray(pz.seq)) {
      const goEl = document.getElementById('go');
      const demoRunning = !!(goEl && goEl.style.display !== 'none');
      const anyEnabled = cells.some(c => !c.hasAttribute('disabled'));
      if (anyEnabled && !demoRunning) {
        if (!window.__seqPlan || !window.__seqPlan.length) {
          window.__seqPlan = pz.seq.map(Number);
          steps.push('seqPlan:[' + window.__seqPlan.join(',') + ']');
        }
        const idx = window.__seqPlan.shift();
        const target = cells.find(c => Number(c.dataset.i) === idx) || cells[idx];
        click(target);
        steps.push('seq:' + idx);
        await sleep(380);
        continue;
      }
      steps.push(demoRunning ? 'seqDemo' : 'seqWait');
    }

    // ── ready 兜底：数字关/颜色关的 ready 放这里不影响正确性，
    //    序列关那三条陷阱已在上面排掉
    const ready = [...document.querySelectorAll('button')].find(b =>
      /準備好了|准备好了|开始展示|Show me|Ready/i.test(b.textContent || '') && !b.disabled);
    if (ready) { click(ready); steps.push('ready:' + h2.slice(0, 14)); await sleep(300); continue; }

    const next = [...document.querySelectorAll('button')].find(b =>
      /^(继续|Continue|続ける|Siguiente|Continuer)/i.test((b.textContent || '').trim()) && !b.disabled);
    if (next) { click(next); steps.push('next'); await sleep(320); continue; }

    // 演示动画期间（数字关逐位闪现最长 5s、颜色关展示 4.2s），安静等一拍
    await sleep(200);
  }
  return steps;
`;

const PROFILE = path.join(os.tmpdir(), `md-live-${process.pid}`);
let edge = null;

async function withPage(label, fn) {
  edge = spawn(EXE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=18941',
    `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: 'ignore', detached: false });

  const c = await CDP.attach(18941);
  try {
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    await c.send('Page.enable');
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM });
    await fn(c);
  } finally {
    c.close();
    try { edge.kill(); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
  }
}

console.log(`\n═══ P1-4 线上验收：${ORIGIN} ═══\n`);
console.log('[1] 真实站点 · 真前端 · 真引擎（submit 走 mock，不写连胜/榜单）');
await withPage('线上', async (c) => {
  await c.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=daily` });
  await c.waitFor(() => c.eval('return !!window.ShareCard'), 20000)
    .then((r) => ok(r, '线上 ShareCard 引擎已加载'));

  // autoplay 分批驱动（先驱动，判定在驱动循环内部做）
  //
  // 🔴 结构性坑：**不能先 waitFor 终局再驱动 autoplay**。
  //    waitFor 是死等，autoplay 没跑就永远到不了终局 —— 实测 180s 超时，
  //    事后诊断却显示页面早就在终局了（againBtn + .dc-rank 都在）。
  //    判定必须放在驱动循环里，和推进动作同一条时间线上。
  let atFinal = false;
  for (let i = 0; i < 260; i++) {
    atFinal = await c.eval(`
      return !!document.querySelector('.dc-err')
        || (!!document.getElementById('againBtn') && !!document.querySelector('.dc-rank'));
    `);
    if (atFinal) break;
    try { await c.eval(AUTOPLAY_STEP); } catch (_) { /* 导航期批次丢失，重试 */ }
    await sleep(120);
  }
  ok(atFinal, '真实每日挑战跑完三关到达终局');

  const st = await c.eval(`return {
    isErr: !!document.querySelector('.dc-err'),
    errText: (document.querySelector('.dc-err')||{}).textContent || '',
    hasShare: !!document.querySelector('.dc-share'),
    hasImg: !!document.querySelector('.dc-share-img'),
    hasText: !!document.querySelector('.dc-share-text'),
    finalTitle: (document.querySelector('.dc-h2')||{}).textContent || '',
    rankRows: document.querySelectorAll('.dc-rank-row').length,
    score: (document.querySelector('.dc-result-score')||{}).textContent || '',
    today: window.__liveToday,
    submits: window.__submits,
    diag: window.__diag,
  };`);

  ok(!st.isErr, `没有走到错误页${st.isErr ? '（' + st.errText.slice(0, 80) + '）' : ''}`);
  ok(st.rankRows === 3, `终局三关成绩行都在（${st.rankRows}/3）`);
  ok(/^\d+$/.test(String(st.score).trim()) && Number(st.score) > 0,
    `终局总分已渲染（${st.score}）`);
  ok(Array.isArray(st.submits) && st.submits.length >= 3,
    `submit 被 mock 拦截（记录 ${(st.submits || []).length} 次）`);
  // 🔴 长度必须先于 every：空数组的 every 恒为 true，
  //    零次提交会被判成「每次都带 answer」——比不测更坏。
  ok(Array.isArray(st.submits) && st.submits.length > 0 && st.submits.every((s) => s.hasAnswer),
    `每次 submit 都带了 answer（${(st.submits || []).length} 次）`);
  ok(!!(st.today && st.today.date), `真实后端返回今日日期（${(st.today || {}).date || '无'}）`);

  const leaks = await c.eval('return window.__realSubmitHits || 0;');
  ok(leaks === 0, `零泄漏：submit 未触达真实后端（泄漏 ${leaks} 次）`);

  ok(st.hasShare, '终局页挂出了分享区');
  if (st.hasShare) {
    const img = await c.eval(`
      const el = document.querySelector('.dc-share-img');
      if (!el) return null;
      return { src: (el.getAttribute('src')||'').slice(0, 30), natW: el.naturalWidth, natH: el.naturalHeight,
               visible: !!el.offsetParent, alt: el.getAttribute('alt') };
    `);
    ok(!!img && img.src.startsWith('data:image/png'), '预览图是 PNG dataURL');
    ok(!!img && img.natW === 1200 && img.natH === 630, `预览图 1200×630（实得 ${img ? img.natW + '×' + img.natH : '无'}）`);
    ok(!!img && img.visible, '预览图可见');
    ok(!!img && !!img.alt, '预览图有 alt 文案（无障碍）');

    const btns = await c.eval(`
      return [...document.querySelectorAll('.dc-share-actions button')].map(b => (b.textContent||'').trim());
    `);
    ok(btns.length >= 2, `下载/复制按钮都在（${JSON.stringify(btns)}）`);

    const again = await c.eval(`
      const b = document.getElementById('againBtn');
      return { exists: !!b, text: b ? (b.textContent||'').trim() : '', visible: !!(b && b.offsetParent) };
    `);
    ok(again.exists, '终局「再玩一次」按钮在 DOM 里');
    ok(again.exists && again.visible, '「再来一次」未被分享区挤掉（可见）');
  }

  // 直调引擎确认真实 1200×630 且画面非空白
  const direct = await c.eval(`
    const cv = document.createElement('canvas');
    const card = { game: 'daily-challenge', icon: '🧠', gameName: 'Daily Challenge',
                   title: '74 / 74', subtitle: 'all levels maxed',
                   url: location.origin + '/games/daily-challenge/lobby/', metaLines: ['🔥 4 streak'] };
    window.ShareCard.renderCard(cv, card, 'memory');
    return { w: cv.width, h: cv.height };
  `).catch((e) => ({ err: String(e.message) }));
  ok(direct.w === 1200 && direct.h === 630, `引擎直调 1200×630（实得 ${direct.w || '—'}×${direct.h || '—'}）`);

  // 抓真实终局分享卡存盘
  const dataUrl = await c.eval(`
    const el = document.querySelector('.dc-share-img');
    return el ? (el.getAttribute('src') || '') : '';
  `);
  if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
    const b64 = dataUrl.slice('data:image/png;base64,'.length);
    fs.writeFileSync(CARD_OUT, Buffer.from(b64, 'base64'));
    const kb = (fs.statSync(CARD_OUT).size / 1024).toFixed(1);
    ok(fs.statSync(CARD_OUT).size > 8000, `分享卡已存盘（${kb} KB）`);
    console.log(`       → ${CARD_OUT}`);
  } else {
    ok(false, '未能取到终局分享卡 dataURL');
  }

  const probs = c.problems().concat(st.diag || []);
  ok(probs.length === 0, `无未捕获异常 / console.error / 资源错误（${probs.length}）${probs.length ? '：' + probs[0].slice(0, 120) : ''}`);

  if (fail) {
    const diag = await c.eval(`return {
      apSteps: (window.__apSteps || []).join(' → '),
      puzzleSeq: window.__mdPuzzleSeq,
      puzzle: window.__mdPuzzle,
      h2: (document.querySelector('.dc-h2')||{}).textContent || '',
      buttons: [...document.querySelectorAll('button')].map(b => ({
        t: (b.textContent||'').trim().slice(0, 12), dis: b.disabled,
      })).filter(b => b.t),
      ansVal: (document.getElementById('ans')||{}).value,
      seqCells: [...document.querySelectorAll('.dc-seq-cell')].map(c => c.hasAttribute('disabled') ? 0 : 1).join(''),
      hasLock: !!document.getElementById('lock'),
      hasGrid: !!document.getElementById('grid'),
    };`);
    console.log('\n  ── 失败诊断 ──');
    console.log('  autoplay:', (diag.apSteps || '(空)').slice(0, 700));
    console.log('  puzzleSeq=', diag.puzzleSeq, ' puzzle=', JSON.stringify(diag.puzzle));
    console.log('  当前关卡 h2=', JSON.stringify(diag.h2));
    console.log('  按钮=', JSON.stringify(diag.buttons));
    console.log('  ans=', JSON.stringify(diag.ansVal), ' seqCells(disabled=0)=', diag.seqCells,
      ' hasLock=', diag.hasLock, ' hasGrid=', diag.hasGrid);
    if (probs.length) console.log('  问题=', JSON.stringify(probs.slice(0, 4)));
  }
});

console.log(`\n═══ 线上验收：${pass} pass / ${fail} fail ═══\n`);
process.exit(fail ? 1 : 0);