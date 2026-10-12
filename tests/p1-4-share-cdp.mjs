/**
 * P1-4 分享卡 · CDP 无头浏览器验收（L3）
 * ────────────────────────────────────────────────────────────────
 * 🔴 三条踩坑记录（每次都省不得）：
 *
 * 1. 不能用 puppeteer：本机 Edge 在当前环境下被 puppeteer 拉起会以 Code: 0
 *    静默退出（stderr 空）。改为手动 spawn + CDP over WebSocket，Node 22
 *    内置全局 WebSocket，零依赖。
 *
 * 2. 不能用 CDP Fetch 域拦脚本：Fetch.enable 之后 Page.navigate 会被
 *    自己发出的 requestPaused 事件死锁（实测 requestPaused 一个都收不到，
 *    脚本直接挂住 2 分半）。改用**真起一个 mock API + 静态服务**，
 *    页面加载真实的 daily-client.js，只把后端接口指向 mock。
 *    这样验的是真实代码路径，不存在「桩子被真脚本覆盖导致静默验错路径」。
 *
 * 3. 不能只等 #card 存在：错误页也有 #card。必须轮询等
 *    .dc-result-score（真到终局）或 .dc-err（明确失败）二者之一。
 *
 * 验证四件事：
 *  1. ShareCard 引擎加载成功，终局页渲染出 1200×630 且画面非空白
 *  2. 分享区挂载、预览图可见、下载/复制按钮可点、主体按钮未被挤掉
 *  3. 引擎缺失 → 降级为文本摘要，成绩与「再来一次」不受影响
 *  4. Canvas 2d 不可用 → 同样降级，无未捕获异常
 *
 * 用法：node tests/p1-4-share-cdp.mjs [--base=http://localhost:4188] [--keep-mock]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'dist');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? '1'] : [a, '1'];
}));
const KEEP_MOCK = !!argv['keep-mock'];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

/* ═══════════════════════════════════════════════════════════════
   Mock 后端：把 /api/md/daily 全系列指向确定性的满分数据
   ═══════════════════════════════════════════════════════════════
   🔴 响应必须是 {ok:true, data:{...}} 信封 —— daily-client.js 每个端点都这么判：
        if (!body || !body.ok || !body.data) throw ...
      漏掉信封的表现极具迷惑性：页面显示「响应格式异常」，
      而真实后端完全正常，看起来像产品 bug，其实是 mock 不合约。
   🔴 puzzle 还要多一层 data.puzzle（fetchPuzzle 显式校验 body.data.puzzle）。 */
const TOTALS = { 'number-recall': 12, 'sequence-memory': 12, 'color-recall': 50 };
const roundMax = (g, r) => (g === 'color-recall' ? 50 : r);

/** 🔴 题目生成器必须**唯一**，且 puzzle 与 submit 共用同一份。
 *   两处各写一遍生成逻辑时，只要一边改了公式，submit 就会拿另一套「标准答案」
 *   去判分，表现为「明明全答对了却只得 0 分」——极难定位。
 *
 *   🔴 数字序列不能有重复：digitsOf 用 (i*3+r)%10，三位以内会撞出重复
 *   （round1 = 3,6,9 对得上，但换成别的 r 就会重复），
 *   而前端「输入满位数即提交」在有重复时会与某些实现打架。
 *   这里用固定不重复的调色板按轮次错位，保证任意轮次都是**互不相同**的位。 */
const DIGIT_POOL = [4, 7, 2, 9, 1, 6, 3, 8, 5, 0];
function digitsOf(_g, r) {
  const len = 2 + r; // 3/4/5，与 roundMax 对齐
  // 步长 2 与长度 ≤5 时，(r*3 + i*2) mod 10 在前 5 项内互不相同（2 与 10 不整除且互质关系成立），
  // 但为绝对安全这里显式去重：一旦出现重复就往后顺延取值。
  const used = new Set();
  let s = '';
  for (let i = 0; s.length < len && i < 40; i++) {
    const v = DIGIT_POOL[(r * 3 + i * 2) % 10];
    if (used.has(v)) continue;
    used.add(v);
    s += String(v);
  }
  return s;
}
function seqOf(r) {
  const len = 2 + r;
  const seq = [];
  for (let i = 0; i < len; i++) seq.push((i * 2 + r) % 9);
  return seq;
}
/** 🔴 契约是 HSB **对象**数组 [{h,s,b}]，不是颜色名字符串。
 *  playColor 直接读 c.h / c.s / c.b，喂字符串会得到 NaN 度色。 */
const COLORS_HSB = [
  { h: 0, s: 82, b: 62 }, { h: 210, s: 74, b: 58 },
  { h: 120, s: 66, b: 52 }, { h: 45, s: 88, b: 60 },
  { h: 280, s: 60, b: 55 },
];

/** 颜色得分：按 HSB 三维距离给 0-50 */
function scoreColor(colors, answer) {
  const a = Array.isArray(answer) ? answer : [];
  if (!a.length) return 0;
  let sum = 0;
  for (let i = 0; i < Math.min(colors.length, a.length); i++) {
    const t = colors[i], q = a[i] || {};
    const dhRaw = Math.abs(Number(t.h) - Number(q.h));
    const dh = Math.min(dhRaw, 360 - dhRaw);
    const ds = Math.abs(Number(t.s) - Number(q.s));
    const db = Math.abs(Number(t.b) - Number(q.b));
    const dist = dh / 180 + ds / 100 + db / 100;
    sum += Math.max(0, Math.round(50 * (1 - dist)));
  }
  return Math.min(50, sum);
}

/** mock 收到的前几条 submit（诊断用） */
const mockLog = [];

function startMock(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.pathname;

    // 🔴 submit 是 POST，game/round 在**请求体**里而不是 query。
    //    不读完 body 的话 keep-alive 连接会挂住，后续请求全排队等死。
    let rawBody = '';
    if (req.method === 'POST') {
      for await (const chunk of req) rawBody += chunk;
    }
    let bodyObj = {};
    try { bodyObj = rawBody ? JSON.parse(rawBody) : {}; } catch (_) { bodyObj = {}; }

    const send = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, data }));
    };

    if (p.endsWith('/daily/today')) {
      // 🔴 /today 就是「新的一天」入口：在这里重置累计分。
      //   否则三个场景共用同一个 mock 时，分数会跨场景累加
      //   （第二次跑看到 124/74，比第一次多 62），断言直接失真。
      server._totals = { 'number-recall': 0, 'sequence-memory': 0, 'color-recall': 0 };
      return send({
        date: '2026-10-13',
        levels: [
          { game: 'number-recall', rounds: 3, maxScore: 12 },
          { game: 'sequence-memory', rounds: 3, maxScore: 12 },
          { game: 'color-recall', rounds: 1, maxScore: 50 },
        ],
        done: {}, score: {}, streak: 4,
      });
    }
    if (/\/daily\/puzzle/.test(p)) {
      const g = url.searchParams.get('game') || 'number-recall';
      const r = +(url.searchParams.get('round') || 1);
      if (g === 'sequence-memory') {
        return send({ game: g, round: r, puzzle: { game: g, round: r, seq: seqOf(r), grid: 3 } });
      }
      if (g === 'color-recall') {
        return send({ game: g, round: r, puzzle: { game: g, round: r, colors: COLORS_HSB } });
      }
      return send({
        game: g, round: r,
        puzzle: { game: g, round: r, digits: digitsOf(g, r).split('').map(Number) },
      });
    }
    if (/\/daily\/streak/.test(p)) return send({ streak: 4 });
    if (/\/daily\/rank/.test(p)) return send({ rows: [], note: 'mock' });

    if (/\/daily\/submit/.test(p)) {
      const g = bodyObj.game || url.searchParams.get('game') || 'number-recall';
      const r = +(bodyObj.round || url.searchParams.get('round') || 1);
      const mx = roundMax(g, r);

      // 🔴 按答案算分，不能一律返回满分。
      //   一律满分会让终局页出现「36 / 74 · 全部关卡满分」这种自相矛盾的画面，
      //   看起来像前端 bug，其实是 mock 不真实。
      //   口径对齐 worker/src/sites/memoryduel/routes/daily.js 的 judgeAgainst：
      //     number / sequence：完全正确才给满分
      //     color：按 HSB 距离给 0-50
      let score = 0;
      // 🔴 answer 是**裸值**（submitAnswer 传 played.answer），不是 {answer:...} 包一层。
      //   读成 bodyObj.answer.answer 会永远得到 undefined → 判 0 分，
      //   表现为「明明全答对了却 0 分」，很容易误判成前端没提交答案。
      const ans = bodyObj.answer;
      // 🔴 诊断日志：mock 收不到答案时，唯一能定位的办法就是把收到的 body 打出来。
      //   （本项目已踩：answer 形状理解错一次，读成 bodyObj.answer.answer → 永远 undefined）
      if (!mockLog.length) mockLog.push({ game: g, round: r, bodyKeys: Object.keys(bodyObj), ansType: typeof ans, ans });
      if (g === 'number-recall') {
        const truth = digitsOf(g, r);
        const a = String(ans == null ? '' : ans);
        score = (a.length === truth.length && a === truth) ? mx : 0;
      } else if (g === 'sequence-memory') {
        const truth = seqOf(r);
        const a = Array.isArray(ans) ? ans : [];
        const ok = a.length === truth.length && a.every((v, i) => Number(v) === truth[i]);
        score = ok ? mx : 0;
      } else {
        score = scoreColor(COLORS_HSB, Array.isArray(ans) ? ans : []);
      }

      const total = (server._totals[g] || 0) + score;
      server._totals[g] = total;
      return send({
        score, total,
        perfect: total >= TOTALS[g],
        round: r,
      });
    }

    // 身份：桩不需要真鉴权
    if (/\/session|\/identity|\/auth/.test(p)) return send({ pid: 'mock-pid', token: 'mock-token' });

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `mock 404: ${p}` }));
  });
  return new Promise((resolve) => {
    // 🔴 按玩家累计各关总分（submit 时累加），供 perfect 判定用
    server._totals = { 'number-recall': 0, 'sequence-memory': 0, 'color-recall': 0 };
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

/** 静态服务 + 把 /api/md/daily* 反代到 mock */
function startStatic(port, apiPort) {
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, `http://127.0.0.1:${port}`).pathname;

    if (p.startsWith('/api/md/')) {
      // 🔴 反代必须带 method + 请求体。用无参 fetch 转发会让 POST submit
      //   变成空 GET —— 症状是「明明答对了却 0 分」，因为 mock 收不到 answer。
      try {
        const chunks = [];
        if (req.method === 'POST' || req.method === 'PUT') {
          for await (const c of req) chunks.push(c);
        }
        const r = await fetch(`http://127.0.0.1:${apiPort}${req.url}`, {
          method: req.method,
          headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        });
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(buf);
      } catch (e) {
        res.writeHead(502); res.end('proxy error: ' + e.message);
      }
      return;
    }

    let file = path.join(DIST, decodeURIComponent(p));
    if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 ' + p);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/* ═══════════════════════════════════════════════════════════════
   CDP 客户端
   ═══════════════════════════════════════════════════════════════ */
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
        const en = e.params.entry;
        out.push('资源错误: ' + en.text + ' ' + (en.url || ''));
      }
    }
    return out;
  }
  async waitFor(fn, timeout = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await fn()) return true; } catch (_) { /* 页面还没就绪 */ }
      await sleep(150);
    }
    return false;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

const DIAG_HOOK = `
window.__diag = [];
const _oe = console.error;
console.error = function () {
  window.__diag.push('console.error: ' + Array.prototype.map.call(arguments, String).join(' '));
  _oe.apply(console, arguments);
};
window.addEventListener('error', function (e) { window.__diag.push('window.error: ' + e.message); });
window.addEventListener('unhandledrejection', function (e) {
  window.__diag.push('unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason));
});

// 🔴 抓 puzzle 响应：数字关的答案在 stage 清空后就看不到了，
//    序列关的格子序列也只在高亮瞬间可见。唯一稳定的来源是网络响应体。
//    （真实后端不会把答案发给前端 —— 但这里连的是本测试的 mock，
//      mock 本来就是确定性的，所以这不算「作弊」，只是在补 mock 侧的信息。）
window.__mdPuzzle = null;
window.__mdPuzzleSeq = 0;
(function () {
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    return _fetch.call(this, input, init).then(function (r) {
      if (String(input).indexOf('/puzzle') >= 0) {
        r.clone().json().then(function (j) {
          if (j && j.data && j.data.puzzle) {
            window.__mdPuzzle = j.data.puzzle;
            window.__mdPuzzleSeq++;
            // 换题时清掉上一题的进度计数
            window.__seqClicked = false;
            window.__colN = 0;
          }
        }).catch(function () {});
      }
      return r;
    });
  };
})();
`;

/* ═══════════════════════════════════════════════════════════════
   自动通关：分批驱动，每批只跑 1.5s
   ═══════════════════════════════════════════════════════════════
   🔴 踩坑 1：不能写成一条长 eval。
      页面自己导航/重渲染时，CDP 会把正在执行的 evaluate 一起丢掉，
      报「Inspected target navigated or closed」，autoplay 静默返回空数组，
      根本不知道跑到哪一步。分批后每批 1.5s，导航最多影响一批。

   🔴 踩坑 2：ready 分支必须排在序列/颜色分支**之前**。
      序列关一上来就渲染 9 个 .dc-seq-cell（演示还没开始），
      先查格子就永远等不到「开始展示」。

   🔴 踩坑 3：数字关没有提交按钮 —— playNumber 监听 input 事件，
      位数填满即 resolve。去找「提交按钮」会空转到底。

   🔴 踩坑 4：答案只能从 puzzle 响应拿。stage 在展示整串之后会被清空
      （playNumber 末尾 stage.textContent=''），等输入框解禁时早已看不见。

   🔴 踩坑 5：终局判定必须看到「再来一次」。单轮结果页也有 .dc-result-score，
      只看它会在第一轮就收工。 */
const AUTOPLAY_STEP = `
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  if (!window.__apSteps) window.__apSteps = [];
  const steps = window.__apSteps;
  const deadline = Date.now() + 1500;

  while (Date.now() < deadline) {
    const again = [...document.querySelectorAll('button')].find(b =>
      /^(再来一次|Play again|もう一度)/i.test((b.textContent || '').trim()));
    if (q('.dc-err') || (again && q('.dc-rank'))) { steps.push('final'); return steps; }

    const ready = [...document.querySelectorAll('button')].find(b =>
      /准备好了|準備好了|开始展示|Show me|Ready/i.test(b.textContent || '') && !b.disabled);
    if (ready) { click(ready); steps.push('ready'); await sleep(300); continue; }

    const lock = document.getElementById('lock');
    if (lock && !lock.disabled) {
      window.__colN = (window.__colN || 0) + 1;
      click(lock); steps.push('lock#' + window.__colN); await sleep(340); continue;
    }

    const next = [...document.querySelectorAll('button')].find(b =>
      /^(继续|Continue|続ける)/i.test((b.textContent || '').trim()) && !b.disabled);
    if (next) { click(next); steps.push('next'); await sleep(320); continue; }

    const cells = [...document.querySelectorAll('.dc-seq-cell')];
    if (cells.length) {
      const seq = (window.__mdPuzzle && window.__mdPuzzle.seq) || null;
      const demoDone = cells.every(c => !c.hasAttribute('disabled'));
      if (demoDone && seq && seq.length && !window.__seqClicked) {
        for (const i of seq) { click(cells[i]); await sleep(140); }
        steps.push('seq:' + seq.join(''));
        window.__seqClicked = true;
        await sleep(360);
        continue;
      }
      await sleep(180); continue;
    }

    const numIn = q('.dc-input');
    if (numIn && !numIn.disabled) {
      const need = +(numIn.getAttribute('maxlength') || 0);
      if (need > 0 && numIn.value.length < need) {
        const digits = ((window.__mdPuzzle && window.__mdPuzzle.digits) || [])
          .map(String).join('').slice(0, need);
        if (digits.length === need) {
          for (let i = 0; i < digits.length; i++) {
            numIn.value = digits.slice(0, i + 1);
            numIn.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(45);
          }
          steps.push('num:' + digits);
        }
      }
      await sleep(180); continue;
    }

    await sleep(180);
  }
  return steps;
`;

/** 分批驱动自动通关，直到终局或批次用尽。 */
async function autoplay(c, maxBatches = 120) {
  let last = [];
  for (let i = 0; i < maxBatches; i++) {
    let steps;
    try {
      steps = await c.eval(AUTOPLAY_STEP);
    } catch (e) {
      // 页面刚导航/重渲染时这一批会丢，跳过继续下一批
      if (/navigated or closed|Cannot find context|Execution context/i.test(e.message)) {
        await sleep(300);
        continue;
      }
      throw e;
    }
    last = steps || [];
    if (last.includes('final')) break;
  }
  return last;
}

/* ═══════════════════════════════════════════════════════════════
   跑一个场景
   ═══════════════════════════════════════════════════════════════ */
async function withPage(port, label, extras, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `md-p14-${port}-`));
  const proc = spawn(EXE, [
    '--headless=new', `--remote-debugging-port=${port}`,
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    cdp = await CDP.attach(port);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    if (extras) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: extras });

    await cdp.send('Page.navigate', { url: PAGE_URL });

    const engineReady = await cdp.waitFor(() =>
      cdp.eval('return !!document.querySelector("#card") && !!window.ShareCard;'), 20000);

    // 🔴 必须等「终局页」或「错误页」二者之一，不能只看 #card。
    //    先等离开加载态，再驱动自动通关，最后确认落到终局。
    await cdp.waitFor(() =>
      cdp.eval('return !document.querySelector(".dc-loading");'), 20000);

    let autoplaySteps = [];
    // 🔴 诊断模式也必须跑 autoplay：不跑就只能看到第一关，看不出流程能不能走通
    autoplaySteps = await autoplay(cdp).catch((e) => ['autoplay 异常: ' + e.message]);
    cdp.autoplaySteps = autoplaySteps;

    const settled = await cdp.waitFor(() =>
      cdp.eval('return !!document.querySelector(".dc-result-score") || !!document.querySelector(".dc-err");'), 10000);

    await fn(cdp, { engineReady, settled, autoplaySteps });
  } catch (e) {
    fail++; console.log(`  FAIL ${label} 执行异常: ${e.message}`);
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (_) {}
    await sleep(250);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

/* ═══════════════════════════════════════════════════════════════
   启动 mock
   ═══════════════════════════════════════════════════════════════ */
if (!fs.existsSync(path.join(DIST, 'games/daily-challenge/index.html'))) {
  console.error(`找不到构建产物 ${DIST}/games/daily-challenge/index.html —— 先跑 npm run build`);
  process.exit(2);
}
const API_PORT = 18911, WEB_PORT = 18912;
const PAGE_URL = `http://127.0.0.1:${WEB_PORT}/games/daily-challenge/?mode=daily`;

const mock = await startMock(API_PORT);
const stat = await startStatic(WEB_PORT, API_PORT);

/* 诊断模式 */
if (argv.diag) {
  await withPage(18921, '诊断', DIAG_HOOK, async (c, r) => {
    console.log('  engineReady =', r.engineReady, ' settled =', r.settled);
    const st = await c.eval(`
      return {
        cardText: (document.querySelector('#card')||{}).innerText ? document.querySelector('#card').innerText.slice(0,400) : null,
        hasFinal: !!document.querySelector('.dc-result-score'),
        hasShareBox: !!document.querySelector('.dc-share'),
        hasImg: !!document.querySelector('.dc-share-img'),
        hasText: !!document.querySelector('.dc-share-text'),
        autoplay: window.__autoplaySteps || [],
        diag: window.__diag,
      };
    `);
    console.log(JSON.stringify(st, null, 2));
    console.log('  autoplay:', (r.autoplaySteps || []).join(' → '));
    console.log('  mock submit:', JSON.stringify(mockLog));
    const dom = await c.eval(`
      return {
        cardText: (document.querySelector('#card')||{}).innerText || '',
        puzzle: window.__mdPuzzle,
        puzzleSeq: window.__mdPuzzleSeq,
        seqClicked: window.__seqClicked,
        colN: window.__colN,
        cells: document.querySelectorAll('.dc-seq-cell').length,
        hasLock: !!document.getElementById('lock'),
        buttons: [...document.querySelectorAll('button')].map(b=>(b.textContent||'').trim().slice(0,10)).filter(Boolean),
      };
    `);
    console.log('  DOM:', JSON.stringify(dom));
  });
} else {

/* ═══════════════════════════════════════════════════════════════
   [1] 正常路径
   ═══════════════════════════════════════════════════════════════ */
console.log('\n[1] 正常路径 —— 真脚本 + mock 后端');
await withPage(18931, '正常路径', DIAG_HOOK, async (c, r) => {
  ok(r.engineReady, '页面就绪且 ShareCard 引擎已加载');
  ok(r.settled, '页面已走到终局或错误页');

  const st0 = await c.eval(`return {
    isError: !!document.querySelector('.dc-err'),
    errText: (document.querySelector('.dc-err')||{}).textContent || '',
  };`);
  ok(!st0.isError, `没有走到错误页（${st0.errText || 'OK'}）`);

  const ui = await c.eval(`
    const img = document.querySelector('.dc-share-img');
    return {
      finalScore: (document.querySelector('.dc-result-score')||{}).textContent || '',
      // 🔴 反斜杠要写两重：这段代码位于模板字符串里，\\d 传给页面才是 \d。
      //    写成 \d 会在模板求值时变成 d，页面 eval 抛
      //    「Invalid regular expression: missing /」。
      allLevelsScored: [...document.querySelectorAll('.dc-rank-row')]
        .filter(r => /^\\s*\\d+\\s*\\/\\s*\\d+/.test((r.querySelector('.sc')||{}).textContent || ''))
        .filter(r => Number(((r.querySelector('.sc')||{}).textContent||'0').split('/')[0].trim()) > 0).length,
      hasShareBox: !!document.querySelector('.dc-share'),
      imgSrcHead: img ? (img.getAttribute('src')||'').slice(0,22) : null,
      imgNatural: img ? (img.naturalWidth||0) : 0,
      imgShown: img ? getComputedStyle(img).display !== 'none' : false,
      dlBtn: !!document.getElementById('dlBtn'),
      cpBtn: !!document.getElementById('cpBtn'),
      hasText: !!document.querySelector('.dc-share-text'),
      againBtn: !!document.getElementById('againBtn'),
      backLink: !!document.querySelector('a[href="/games/daily-challenge/lobby/"]'),
      diag: window.__diag,
    };
  `);
  // 🔴 不能写死 74：autoplay 只保证流程走通，不保证每关都满分。
  //    颜色关按 HSB 距离判分，数字/序列关取决于 autoplay 填的是否与 puzzle 一致。
  //    断言「总分在有效区间且三关都有分」，避免把 mock 的判分口径硬编码成产品断言。
  const score = Number(ui.finalScore);
  ok(Number.isFinite(score) && score > 0 && score <= 74,
    `终局总分在有效区间 (0,74]（实得 ${ui.finalScore}）`);
  ok(ui.allLevelsScored === 3, `三关都有分数记录（${ui.allLevelsScored}/3）`);
  ok(ui.hasShareBox, '终局页挂出了分享区');
  ok(ui.imgSrcHead && ui.imgSrcHead.startsWith('data:image/png'), `预览图是 PNG dataURL（${ui.imgSrcHead}）`);
  ok(ui.imgNatural === 1200, `预览图 naturalWidth=1200（实得 ${ui.imgNatural}）`);
  ok(ui.imgShown, '预览图可见');
  ok(ui.dlBtn && ui.cpBtn, '下载 / 复制按钮都在');
  ok(!ui.hasText, '可用路径不该出现文本降级区');
  ok(ui.againBtn, '「再来一次」未被分享区挤掉');
  ok(ui.backLink, '返回大厅链接仍在');

  // 引擎直调：独立验证 1200×630 + 真绘制
  const card = await c.eval(`
    const cv = document.createElement('canvas');
    window.ShareCard.renderCard(cv, {
      game: 'daily-challenge', icon: '\\u{1F9E0}', gameName: 'Daily Challenge',
      title: '74 / 74', subtitle: 'all levels maxed',
      cta: 'Same puzzles for everyone — can you beat it?',
      url: 'https://memoryduel.com/games/daily-challenge/lobby/?from=sabc123',
      metaLines: ['\\u{1F525} 4 Day streak','\\u{1F4AF} 3/3 all levels maxed','\\u2B50 74 / 74','\\u{1F4C5} 2026-10-13'],
    }, 'memory');
    const ctx = cv.getContext('2d');
    const pts = [[40,40],[600,100],[120,300],[600,315],[1100,560],[600,600],[300,450],[120,180]];
    const colors = pts.map(([x,y]) => { const d = ctx.getImageData(x,y,1,1).data; return d[0]+','+d[1]+','+d[2]; });
    window.__png = cv.toDataURL('image/png');
    return { w: cv.width, h: cv.height, uniq: [...new Set(colors)].length, bytes: window.__png.length };
  `);
  ok(card.w === 1200 && card.h === 630, `引擎直调 1200×630（实得 ${card.w}×${card.h}）`);
  ok(card.uniq >= 3, `画面有真实绘制内容（${card.uniq} 种采样色）`);

  const png = await c.eval('return window.__png;');
  const outPath = path.join(os.tmpdir(), 'md-p1-4-card.png');
  fs.writeFileSync(outPath, Buffer.from(png.split(',')[1], 'base64'));
  console.log(`       卡片已存: ${outPath}（${(fs.statSync(outPath).size/1024).toFixed(1)} KB）`);

  const dl = await c.eval(`
    let err = null;
    try { document.getElementById('dlBtn').click(); } catch (e) { err = String(e); }
    await new Promise(r => setTimeout(r, 500));
    return { err };
  `);
  ok(!dl.err, `点下载不抛错（${dl.err || 'OK'}）`);

  const probs = c.problems().concat(ui.diag || []);
  ok(probs.length === 0, `无未捕获异常 / console.error / 资源错误（${probs.length}）`);
  if (probs.length) console.log('       ', probs.slice(0, 3).join('\n        '));
});

/* ═══════════════════════════════════════════════════════════════
   [2] 引擎缺失 → 文本降级
   ═══════════════════════════════════════════════════════════════ */
console.log('\n[2] 引擎缺失 → 应降级为文本摘要');
await withPage(18932, '引擎缺失', DIAG_HOOK + `
Object.defineProperty(window, 'ShareCard', { get: () => undefined, set: () => {}, configurable: true });
`, async (c, r) => {
  const st = await c.eval(`
    const ta = document.querySelector('.dc-share-text');
    return {
      engine: !!window.ShareCard,
      hasText: !!ta, textValue: ta ? ta.value : '',
      hasImg: !!document.querySelector('.dc-share-img'),
      hasDl: !!document.getElementById('dlBtn'),
      scoreShown: (document.querySelector('.dc-result-score')||{}).textContent || '',
      againBtn: !!document.getElementById('againBtn'),
      diag: window.__diag,
    };
  `);
  ok(!st.engine, '引擎确实不可用（场景构造正确）');
  const sc2 = Number(st.scoreShown);
  ok(Number.isFinite(sc2) && sc2 > 0 && sc2 <= 74,
    `成绩照样显示且在有效区间（实得 ${st.scoreShown}）`);
  ok(st.againBtn, '「再来一次」仍在（降级不阻断主流程）');
  ok(st.hasText, '挂出了文本摘要区');
  ok(/\d+\s*\/\s*74/.test(st.textValue), `文本区含总分（${JSON.stringify(st.textValue.slice(0,60))}）`);
  ok(!st.hasImg && !st.hasDl, '不该出现点不动的图片/下载按钮');

  const probs = c.problems().concat(st.diag || []);
  ok(probs.length === 0, `引擎缺失不产生未捕获异常（${probs.length}）`);
  if (probs.length) console.log('       ', probs.slice(0, 3).join('\n        '));
});

/* ═══════════════════════════════════════════════════════════════
   [3] Canvas 2d 不可用 → 文本降级
   ═══════════════════════════════════════════════════════════════ */
console.log('\n[3] Canvas 2d 不可用 → 应降级为文本摘要');
await withPage(18933, 'Canvas 不可用', DIAG_HOOK + `
(function () {
  var orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    if (type === '2d') return null;
    return orig.apply(this, arguments);
  };
})();
`, async (c, r) => {
  const st = await c.eval(`
    const ta = document.querySelector('.dc-share-text');
    return {
      probeNull: document.createElement('canvas').getContext('2d') === null,
      hasText: !!ta, textValue: ta ? ta.value : '',
      hasImg: !!document.querySelector('.dc-share-img'),
      scoreShown: (document.querySelector('.dc-result-score')||{}).textContent || '',
      diag: window.__diag,
    };
  `);
  ok(st.probeNull, 'getContext("2d") 确实返回 null（场景构造正确）');
  const sc3 = Number(st.scoreShown);
  ok(Number.isFinite(sc3) && sc3 > 0 && sc3 <= 74,
    `成绩照样显示且在有效区间（实得 ${st.scoreShown}）`);
  ok(st.hasText, 'Canvas 不可用时降级为文本摘要');
  ok(/\d+\s*\/\s*74/.test(st.textValue), '文本区含总分');
  ok(!st.hasImg, '不该出现点不动的图片');

  const probs = c.problems().concat(st.diag || []);
  ok(probs.length === 0, `Canvas 不可用不产生未捕获异常（${probs.length}）`);
  if (probs.length) console.log('       ', probs.slice(0, 3).join('\n        '));
});

}

if (!KEEP_MOCK) { mock.close(); stat.close(); }
console.log(`\n═══ P1-4 CDP 验收：${pass} pass / ${fail} fail ═══`);
process.exit(fail ? 1 : 0);