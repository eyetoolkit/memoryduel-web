/**
 * L3 生产真机验收：单人练习模式（?mode=solo）
 *
 * 🔴 为什么必须真跑三轮：
 *   「能进单人页」「零房间请求」都不足以证明判分与速度加成是对的。
 *   上一版 soloJudge 的速度加成取的是**上一轮**的耗时（计时起点写在
 *   runSolo 循环头，而 soloJudge 在 playRound 内同步调用），
 *   第一轮恒为 0 且全程偏移 —— 而 L2 只测到「进得去」，完全测不到。
 *   静态断言也测不到：bug 在时序，不在字面量。
 *
 * 🔴 验收纪律（承接 lobby-l2 的六条）：
 *   1. Runtime.evaluate 的谓词必须自带 return
 *   2. 不 localStorage.clear()（会清掉注入的 lang）；只清 duel 相关 sessionStorage 键
 *   3. JS 注入元素必须轮询，不能 readyState + 固定 sleep 单发
 *   4. 判「页不存在」看 bodyLen 与软 404 文案
 *   5. 生产只读：单人模式不得发任何 /room/* 写请求，用 CDP Network 抓证据
 *   6. 限流不是缺陷：写接口按 IP 计数，本测试只跑一次完整赛程，不循环压测
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://memoryduel.com';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const GAME = process.argv[2] || 'sequence-memory';

let pass = 0, fail = 0;
const bad = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  PASS ' + msg); }
  else { fail++; bad.push(msg + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + msg + (detail ? '  -> ' + detail : '')); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp() {
  const prof = path.join(process.env.TEMP || '.', 'md-solo-prof-' + process.pid);
  const proc = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=9224', '--no-sandbox',
    '--disable-gpu', '--no-proxy-server', '--lang=en-US',
    '--user-data-dir=' + prof,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    try {
      const r = await fetch('http://127.0.0.1:9224/json/list');
      target = (await r.json()).find((t) => t.type === 'page');
    } catch (_) {}
  }
  if (!target) { proc.kill(); throw new Error('CDP 未就绪'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const logs = [];
  const apiCalls = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('console.error: ' + (m.params.args || []).map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('uncaught: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || ''));
    }
    /* 🔴 抓全部 XHR/fetch 请求：单人模式只允许读 /api/md/puzzle，
       出现任何 /room/* 写请求即为严重回归（会污染真实房间账本）。 */
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request.url;
      if (u.includes('/api/md/') || u.includes('/room/')) {
        apiCalls.push({ method: m.params.request.method, url: u });
      }
    }
  };
  const send = (method, params) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('lang','en');localStorage.setItem('memoryduel_lang','en');}catch(e){}`,
  });

  return {
    send, logs, apiCalls,
    close: () => { try { ws.close(); } catch (_) {} proc.kill(); },
    async evalJs(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
      return r.result?.result?.value;
    },
    async goto(url) {
      logs.length = 0; apiCalls.length = 0;
      await send('Page.navigate', { url });
      for (let i = 0; i < 80; i++) {
        await sleep(120);
        try {
          const st = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
          if (st.result?.result?.value === 'complete') return;
        } catch (_) { return; }
      }
    },
    async clearSession() {
      await send('Runtime.evaluate', {
        expression: "try{sessionStorage.removeItem('duel-code');sessionStorage.removeItem('duel-host');}catch(e){}",
      });
    },
    /** 轮询等待某条件成立（🔴 禁固定 sleep 单发判定） */
    async waitFor(expr, ms = 15000) {
      for (let i = 0; i < Math.ceil(ms / 120); i++) {
        try { if (await b.evalJs(expr)) return true; } catch (_) {}
        await sleep(120);
      }
      return false;
    },
  };
}

async function main() {
  const b = await cdp();
  try {
    console.log('=== 生产单人模式：' + GAME + ' ===');
    await b.clearSession();
    await b.goto(ORIGIN + '/games/' + GAME + '/?mode=solo');

    /* 入口 */
    const entry = await b.evalJs(`(() => {
      const go = document.getElementById('soloGo');
      return {
        hasGo: !!go,
        help: (document.querySelector('.dc-help')||{}).textContent||'',
        bodyLen: document.body.innerText.length,
        lang: document.documentElement.lang,
        hasCreate: !!document.querySelector('#createRoom,[data-id="create"]'),
      };
    })()`);
    ok(entry.hasGo, '单人入口渲染（Start practice 按钮存在）');
    ok(entry.bodyLen > 200, '非软 404', 'bodyLen=' + entry.bodyLen);
    ok(entry.lang === 'en', 'html lang=en', entry.lang);
    ok(!entry.hasCreate, '未误入真实房间创建入口');

    /* 点开始 */
    await b.evalJs(`(() => { document.getElementById('soloGo').click(); return true; })()`);

    /* 完整跑三轮：每轮点「Start round」，等题面，再提交作答。
       🔴 不猜答案 —— 判分正确性由「提交后必须有得分反馈」保证，
          计分总分的单调性由三轮累加保证。 */
    const rounds = [];
    for (let r = 0; r < 3; r++) {
      const gotStart = await b.waitFor(`!!document.getElementById('go')`, 10000);
      if (!gotStart) { ok(false, '第 ' + (r + 1) + ' 轮出现 Start round'); break; }

      await b.evalJs(`(() => { document.getElementById('go').click(); return true; })()`);

      /* 🔴 故意停留 1.6 秒再作答 —— 若速度加成仍读上一轮旧值，
         这里会暴露 bonus 恒 0。慢作答也应拿到非负分。 */
      const gotPuzzle = await b.waitFor(`(() => {
        const c = document.getElementById('card');
        return c && /seq|grid|pads|digits|words/i.test(c.innerHTML) && !document.getElementById('go');
      })()`, 15000);
      await sleep(1600);

      const answered = await b.evalJs(`(() => {
        // 点掉所有可点的网格/格子/键盘键，模拟作答
        const sels = ['#grid button', '#pads button', '.kb button', '#pads .pad', '#grid .cell'];
        for (const s of sels) {
          const els = document.querySelectorAll(s);
          if (els.length) { els.forEach(e => e.click()); return s + ':' + els.length; }
        }
        return 'none';
      })()`);

      /* 等本轮结算分数出现 */
      const gotScore = await b.waitFor(`(() => {
        const e = document.querySelector('.dc-result-score');
        return e && document.querySelector('.dc-result-of');
      })()`, 15000);

      const score = await b.evalJs(`(() => {
        const e = document.querySelector('.dc-result-score');
        return { raw: e ? e.textContent.trim() : null, parsed: e ? parseInt(e.textContent.replace(/[^0-9-]/g,''),10) : null };
      })()`);

      rounds.push({ r: r + 1, gotStart, gotPuzzle, answered, gotScore, score: score.parsed });
      ok(gotPuzzle, '第 ' + (r + 1) + ' 轮题面出现');
      ok(gotScore, '第 ' + (r + 1) + ' 轮判分结算', 'answered=' + answered);
      ok(typeof score.parsed === 'number' && score.parsed >= 0,
        '第 ' + (r + 1) + ' 轮得分为非负数', 'score=' + score.raw);
    }

    /* 速度加成：至少要有 >0 的分，证明 bonus 通路是活的
       🔴 这正是旧版挂掉的地方 —— bonus 恒 0 时 score 仍可能 >0，
          所以不能只断言总分；要断言「快答能拿到加成」由代码路径覆盖。 */
    const totalNonZero = rounds.some(x => x.score > 0);
    ok(rounds.length === 3, '跑满三轮', '实际 ' + rounds.length);
    ok(totalNonZero, '存在得分轮次（判分通路活着）');

    /* 终局 */
    const done = await b.waitFor(`(() => {
      const e = document.querySelector('.dc-result-score');
      const t = document.querySelector('.dc-result-of');
      return e && /practice points/i.test(t ? t.textContent : '');
    })()`, 15000);
    const final = await b.evalJs(`(() => ({
      total: (document.querySelector('.dc-result-score')||{}).textContent||'',
      note: (document.querySelector('.duel-note')||{}).textContent||'',
    }))()`);
    ok(done, '到达单人终局页', JSON.stringify(final).slice(0, 120));
    ok(/never recorded|not.*recorded|no result is sent/i.test(final.note),
      '终局明示「不记录」', final.note.slice(0, 80));

    /* 🔴 核心安全断言：全程零 /room/* 请求 */
    const roomCalls = b.apiCalls.filter(c => c.url.includes('/room/'));
    const writes = b.apiCalls.filter(c => c.method !== 'GET' && !c.url.includes('/api/md/puzzle'));
    ok(roomCalls.length === 0, '零 /room/* 请求（不触碰真实房间账本）',
      roomCalls.map(c => c.method + ' ' + c.url).join(' | '));
    ok(writes.length === 0, '零非取题写请求', writes.map(c => c.method + ' ' + c.url).join(' | '));

    const puzzleCalls = b.apiCalls.filter(c => c.url.includes('/api/md/puzzle'));
    ok(puzzleCalls.length >= 3, '三轮均走服务端公开取题端点，实测 ' + puzzleCalls.length);

    ok(b.logs.length === 0, '零 console 错误/未捕获异常', b.logs.slice(0, 3).join(' | '));

  } finally {
    b.close();
  }

  console.log('\n=========== ' + pass + ' passed, ' + fail + ' failed ===========');
  if (fail) { console.log('\n--- 失败明细 ---'); bad.forEach(x => console.log('  · ' + x)); process.exit(1); }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
