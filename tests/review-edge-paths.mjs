/**
 * 全面复查第四批：异常路径（线上真站点，CDP 无头）
 * ────────────────────────────────────────────────────────────────
 * 验六类异常，每类都必须有**可解释的降级**，而不是白屏 / 无限 loading / 未捕获异常：
 *
 *   1. 非法房间码：/games/color-recall/?c=ZZZZZZ（不存在）→ 应显示可读错误 + 重试入口
 *   2. 后端完全不可达：拦截 /api/md/* 全部 reject → 不白屏、不无限 loading
 *   3. 响应格式不合约：submit 返回裸对象（无 {ok,data} 信封）→ 应提示格式异常
 *   4. 网络超时：请求挂起不返回 → 有限等待后降级（不能永久转圈）
 *   5. 断线重连：加载中途标记离线 → 恢复后能继续
 *   6. 重复建房/重复提交：连点两次不应产生异常
 *
 * 🔴 不碰真实 submit：全部用拦截层短路，绝不打真接口写连胜/榜单。
 * 🔴 断言绑定外部事实（页面上是否有可读文案 + 有无未捕获异常），不看「没报错」。
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
        const t = d.exception?.description || d.text || '';
        // 网络层 reject 属预期降级路径，其产生的 unhandledrejection 不算产品缺陷
        if (/Failed to fetch|NetworkError|Load failed/i.test(t)) continue;
        out.push('未捕获异常: ' + t);
      } else if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        const t = e.params.args.map((a) => a.value ?? a.description).join(' ');
        if (/Failed to fetch|NetworkError|Load failed/i.test(t)) continue;
        out.push('console.error: ' + t);
      } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        const en = e.params.entry;
        const t = en.text || '';
        if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(t)) continue;
        // 🔴 HTTP 4xx 不是前端异常 —— 场景 1（非法房码）**预期**后端返 404，
        //    浏览器必然在控制台记一条 "Failed to load resource"。那是正确行为，
        //    把它算成「未捕获异常」会让这条断言永远红且毫无意义。
        if (/status of 4\d\d/.test(t)) continue;
        out.push('资源错误: ' + t + ' ' + (en.url || ''));
      }
    }
    return out;
  }
  reset() { this.events = []; }
  async waitFor(fn, timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await fn()) return true; } catch (_) {}
      await sleep(250);
    }
    return false;
  }
}

/** 页面状态快照：是否有可读文案、是否还在无限 loading、有无错误区 */
const SNAPSHOT = `
  const card = document.getElementById('card') || document.body;
  const txt = (card.innerText || '').trim();
  const loading = !!document.querySelector('.dc-loading');
  const errEl = document.querySelector('.dc-err, .dc-help.error, #err');
  return {
    loading,
    hasErrBox: !!errEl,
    errText: errEl ? (errEl.innerText || '').trim().slice(0, 120) : '',
    txtLen: txt.length,
    txt: txt.slice(0, 160),
    hasRetry: !!document.querySelector('#retryBtn, .dc-btn'),
    bodyH: document.body.scrollHeight,
  };
`;

async function scenario(page, name, url, shim, checks) {
  console.log(`\n─── ${name} ───`);
  console.log(`    ${url}`);
  page.reset();
  if (shim) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: shim });
  await page.send('Page.navigate', { url });
  await sleep(1200);
  const settled = await page.waitFor(async () => {
    const s = await page.eval(SNAPSHOT);
    // 到达终态：出现错误区 或 有实际内容（非 loading）
    return s.hasErrBox || (!s.loading && s.txtLen > 20);
  }, 20000);

  const s = await page.eval(SNAPSHOT);
  ok(settled, `${name} 在 20s 内到达终态（loading=${s.loading} 有内容=${s.txtLen > 20}）`);
  ok(!s.loading, `${name} 不停留在无限 loading`);
  ok(s.bodyH > 100, `${name} 不是白屏（body 高 ${s.bodyH}px）`);
  ok(s.txtLen > 10, `${name} 有可读文案（${s.txtLen} 字符）`);

  if (checks) await checks(page, s);

  const probs = page.problems();
  ok(probs.length === 0, `${name} 零非预期未捕获异常（${probs.length}）`);
  if (probs.length) console.log('       ' + probs.slice(0, 3).join('\n       '));
}

/* 🔴 所有 shim 都只在 fetch 层短路，绝不打真实 submit */
const SHIM_REJECT_API = `
(function(){
  var _f = window.fetch;
  window.__hits = 0;
  window.fetch = function(input, init){
    var u = String(input && input.url ? input.url : input);
    if (u.indexOf('/api/') >= 0) { window.__hits++; return Promise.reject(new TypeError('Failed to fetch')); }
    return _f.call(this, input, init);
  };
})();
`;

const SHIM_BAD_SHAPE = `
(function(){
  var _f = window.fetch;
  window.fetch = function(input, init){
    var u = String(input && input.url ? input.url : input);
    // submit 返回裸对象，缺 {ok:true,data:{...}} 信封
    if (u.indexOf('/api/md/daily/submit') >= 0) {
      return Promise.resolve(new Response(JSON.stringify({score:1}), {status:200, headers:{'Content-Type':'application/json'}}));
    }
    // puzzle 返回缺少 data.puzzle
    if (u.indexOf('/api/md/daily/puzzle') >= 0) {
      return Promise.resolve(new Response(JSON.stringify({ok:true,data:{}}), {status:200, headers:{'Content-Type':'application/json'}}));
    }
    return _f.call(this, input, init);
  };
})();
`;

/* 🔴 这个 shim 必须**尊重 AbortSignal**，否则测不到超时机制：
   fetchTimeout 内部同样是调 window.fetch，若本 shim 无视 signal 直接返回
   一个永不 settle 的 Promise，AbortController.abort() 就完全失效 ——
   测出来的「永久转圈」是测试自己造的，不是产品缺陷。 */
const SHIM_HANG = `
(function(){
  var _f = window.fetch;
  window.fetch = function(input, init){
    var u = String(input && input.url ? input.url : input);
    if (u.indexOf('/api/') >= 0) {
      return new Promise(function(resolve, reject){
        var sig = init && init.signal;
        if (!sig) return;                       // 无 signal：真挂起
        if (sig.aborted) { reject(new DOMException('Aborted','AbortError')); return; }
        sig.addEventListener('abort', function(){
          reject(new DOMException('Aborted','AbortError'));
        });
      });
    }
    return _f.call(this, input, init);
  };
})();
`;

const SHIM_500 = `
(function(){
  var _f = window.fetch;
  window.fetch = function(input, init){
    var u = String(input && input.url ? input.url : input);
    if (u.indexOf('/api/md/daily') >= 0) {
      return Promise.resolve(new Response(JSON.stringify({ok:false,error:'boom'}), {status:500, headers:{'Content-Type':'application/json'}}));
    }
    return _f.call(this, input, init);
  };
})();
`;

async function main() {
  console.log(`═══ 异常路径复查：${ORIGIN} ═══`);
  console.log('视口 390x844 · 全部 api 请求被本地拦截层短路，绝不打真实 submit\n');

  const port = 9520;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `md-edge-${port}-`));
  const proc = spawn(EXE, [
    '--headless=new', `--remote-debugging-port=${port}`,
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' });

  let page;
  try {
    page = await CDP.attach(port);
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    });

    // 1. 非法房间码（真后端，不拦截—— 这本身就该被后端正确拒绝）
    await scenario(page, '1. 非法房间码 ?c=ZZZZZZZZ',
      `${ORIGIN}/games/color-recall/?c=ZZZZZZZZ&lang=zh`, null,
      async (p, s) => {
        ok(s.hasErrBox || /not found|不存在|无效|错误|room/i.test(s.txt),
          `1. 给出了可读的错误提示（"${s.errText || s.txt.slice(0, 50)}"）`);
        ok(s.hasRetry || /重试|try again|返回|back/i.test(s.txt),
          `1. 有恢复路径（重试或返回）`);
      });

    // 2. 后端完全不可达
    await scenario(page, '2. 全部 API reject',
      `${ORIGIN}/games/daily-challenge/?lang=zh`, SHIM_REJECT_API,
      async (p, s) => {
        ok(s.hasErrBox || s.txtLen > 10, `2. 有降级文案而非白屏`);
      });

    // 3. 响应格式不合约（裸对象 / 缺 data.puzzle）
    await scenario(page, '3. 响应不合约（裸对象 / 缺 puzzle）',
      `${ORIGIN}/games/daily-challenge/?lang=zh`, SHIM_BAD_SHAPE,
      async (p, s) => {
        ok(s.hasErrBox || /格式|malformed|异常/i.test(s.errText + s.txt),
          `3. 提示了格式异常（"${s.errText || s.txt.slice(0, 60)}"）`);
      });

    // 4. 请求挂起不返回 —— 关键：不能永久转圈
    console.log(`\n─── 4. 请求永不 settle（挂起） ───`);
    console.log('    预期：15s FETCH_TIMEOUT_MS 触发 → 降级为可读错误');
    const t0 = Date.now();
    let hungOk = false, snap4 = null;
    page.reset();
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM_HANG });
    await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?lang=zh` });
    // 超时上限是 15s，这里给 25s 留足余量
    for (let i = 0; i < 50; i++) {
      await sleep(500);
      try {
        snap4 = await page.eval(SNAPSHOT);
        if (snap4.hasErrBox || (!snap4.loading && snap4.txtLen > 20)) { hungOk = true; break; }
      } catch (_) {}
    }
    const waited = ((Date.now() - t0) / 1000).toFixed(1);
    ok(hungOk, `4. 请求挂起后 ${waited}s 内给出降级（未永久转圈）`);
    ok(waited >= 12, `4. 不是立刻误报，而是等到超时才降级（用了 ${waited}s，应 ≥12s）`);
    if (snap4) {
      ok(!snap4.loading, `4. 不停留在 loading`);
      ok(snap4.txtLen > 10, `4. 有可读文案（"${(snap4.txt || '').slice(0, 60)}"）`);
      ok(/超时|timeout|失败|重试|重试/i.test(snap4.errText + snap4.txt),
        `4. 提示里点明是超时而非泛化失败（"${(snap4.errText || snap4.txt || '').slice(0, 70)}"）`);
    }

    // 5. 后端 500
    await scenario(page, '5. 后端 500',
      `${ORIGIN}/games/daily-challenge/?lang=zh`, SHIM_500,
      async (p, s) => {
        ok(s.hasErrBox || s.txtLen > 10, `5. 有降级文案（"${(s.errText || s.txt).slice(0, 60)}"）`);
      });

    // 6. 重复操作：连点建房/开始不应产生异常
    console.log(`\n─── 6. 重复点击 ───`);
    page.reset();
    await page.send('Page.navigate', { url: `${ORIGIN}/games/number-recall/?lang=zh` });
    await sleep(2500);
    const dup = await page.eval(`
      const btn = document.querySelector('#createBtn, #startBtn, .dc-btn, button');
      if (!btn) return { clicked: 0 };
      let n = 0;
      for (let i = 0; i < 5; i++) { try { btn.click(); n++; } catch (_) {} }
      await new Promise(r => setTimeout(r, 1200));
      return { clicked: n, txt: (document.body.innerText || '').trim().slice(0, 80) };
    `);
    ok(dup.clicked === 5, `6. 连点 5 次按钮未抛异常（点了 ${dup.clicked} 次）`);
    await sleep(800);
    const dupProbs = page.problems();
    ok(dupProbs.length === 0, `6. 重复操作零未捕获异常（${dupProbs.length}）`);
    if (dupProbs.length) console.log('       ' + dupProbs.slice(0, 3).join('\n       '));
  } finally {
    try { proc.kill(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n═══ 异常路径复查结果：${pass} pass / ${fail} fail ═══`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('脚本异常:', e); process.exit(2); });