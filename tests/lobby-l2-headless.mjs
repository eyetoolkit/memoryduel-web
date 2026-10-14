/**
 * L2 本地无头验收：memoryduel 对战大厅 + 三种 mode 深链
 *
 * 🔴 验收纪律（本脚本自身要守的红线）：
 *  1. Runtime.evaluate 的谓词**不能带顶层 return**（会被包进 async IIFE）→ 用 IIFE 表达式
 *  2. 多页面连测前清**真实使用的**存储键：duel-sequence.ts 读 sessionStorage['duel-code']
 *     与 ['duel-host']，不清会让「大厅的 resume 条」跨页误显示，且 ?mode= 分派被绕过
 *  3. JS 注入的元素不能用 readyState=complete + 固定 sleep 单发判定 → 轮询
 *  4. 判「页不存在」要看 body 长度与软 404 文案，不能只看 HTTP 200
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DIST = 'D:/GAME/memoryduel-web/dist';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8931;

const GAMES = ['sequence-memory', 'number-recall', 'color-recall', 'emoji-ghost', 'chimp-test', 'word-recall'];

let pass = 0, fail = 0;
const bad = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  PASS ' + msg); }
  else { fail++; bad.push(msg + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + msg + (detail ? '  -> ' + detail : '')); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, r) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      let f = path.join(DIST, p);
      if (p.endsWith('/')) f = path.join(f, 'index.html');
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        // SPA 式回落到根 index（模拟 CF Pages 的 404 兜底），便于识别「软 404」
        r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        r.end('<html><body>NOT FOUND</body></html>');
        return;
      }
      r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
      r.end(fs.readFileSync(f));
    });
    srv.listen(PORT, '127.0.0.1', () => res(srv));
  });
}

async function cdp() {
  const prof = path.join(process.env.TEMP || '.', 'md-lobby-prof-' + process.pid);
  const proc = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=9223', '--no-sandbox',
    '--disable-gpu', '--no-proxy-server', '--lang=en-US',
    // 🔴 profile 目录必须每次独立：固定目录会残留上一轮的 localStorage['lang']，
    //    于是 --lang=en-US 也不生效 —— 曾因此得到 6 个假失败。
    '--user-data-dir=' + prof,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    try {
      const r = await fetch('http://127.0.0.1:9223/json/list');
      const list = await r.json();
      target = list.find((t) => t.type === 'page');
    } catch (_) {}
  }
  if (!target) { proc.kill(); throw new Error('CDP 未就绪'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error')) {
      logs.push('console.error: ' + (m.params.args || []).map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('uncaught: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || ''));
    }
  };
  const send = (method, params) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  /* 🔴 语言必须在**任何页面脚本之前**定死：
     i18n.js 第 30-31 行的键是 memoryduel_lang 与 lang，且第 73 行按
     navigator.language 兜底 —— 本机无头 Edge 是中文环境，会把整页渲成中文。
     只加 --lang 不够：固定 profile 会残留上轮写入的 localStorage['lang']。
     这里用 addScriptToEvaluateOnNewDocument 在页面脚本前预置，彻底确定。 */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('lang','en');localStorage.setItem('memoryduel_lang','en');}catch(e){}`,
  });

  return {
    send,
    logs,
    close: () => { try { ws.close(); } catch (_) {} proc.kill(); },
    /** 🔴 谓词必须自带 return —— 会被包进 (async()=>{})() */
    async evalJs(expr) {
      const r = await send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true,
      });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' :: ' + (r.result.exceptionDetails.exception?.description || ''));
      return r.result?.result?.value;
    },
    async goto(url) {
      logs.length = 0;
      await send('Page.navigate', { url });
      // 🔴 轮询而非固定 sleep：JS 注入的元素 readyState 也会是 complete
      for (let i = 0; i < 80; i++) {
        await sleep(120);
        try {
          const st = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
          if (st.result?.result?.value === 'complete') return;
        } catch (_) { return; }
      }
    },
    async clearSession() {
      /* 🔴 清真实使用的键：duel-sequence.ts main() 读 duel-code / duel-host。
         🔴 但**不能** localStorage.clear() —— 那会连同 addScriptToEvaluateOnNewDocument
            预置的 lang 一起清掉，导致整页回落浏览器语言（本机=中文）。
            只清 duel 相关键，语言由注入脚本负责。 */
      await send('Runtime.evaluate', {
        expression: "try{sessionStorage.removeItem('duel-code');sessionStorage.removeItem('duel-host');}catch(e){}",
      });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const srv = await serve();
  const b = await cdp();
  const BASE = 'http://127.0.0.1:' + PORT;

  try {
    for (const g of GAMES) {
      console.log('\n=== ' + g + ' 大厅 ===');
      await b.clearSession();
      await b.goto(BASE + '/games/' + g + '/lobby/');

      const info = await b.evalJs(`(async () => {
        const cards = document.querySelectorAll('.dc-modes > *');
        const live = document.querySelectorAll('a.dc-mode');
        const ghost = document.querySelectorAll('div.dc-mode.ghost');
        const h1 = document.querySelectorAll('h1').length;
        const h1s = Array.from(document.querySelectorAll('h1')).map(e => e.textContent.trim().slice(0,40));
        // 触摸目标尺寸
        const small = [];
        document.querySelectorAll('a.dc-mode, .dc-btn, .back').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.height > 0 && r.height < 44) small.push(el.className + ':' + Math.round(r.height));
        });
        return {
          url: location.pathname,
          total: cards.length, live: live.length, ghost: ghost.length,
          h1, h1s, small,
          firstHref: live[0] ? live[0].getAttribute('href') : null,
          bodyLen: document.body.innerText.length,
          lang: document.documentElement.lang,
          rules: document.querySelectorAll('#dlRules .dc-side-row').length,
          mtCreate: (document.querySelector('[data-i18n="dl.mt_create"]')||{}).textContent || '',
          resumeHidden: document.getElementById('dlResume') ? document.getElementById('dlResume').hidden : null,
        };
      })()`);

      ok(info.url === '/games/' + g + '/lobby/', '停在大厅页', info.url);
      ok(info.bodyLen > 300, '非软 404（bodyLen=' + info.bodyLen + '）');
      ok(info.total === 5, '模式卡 5 张（3 真 + 2 灰），实测 ' + info.total);
      ok(info.live === 3, '可点卡 3 张，实测 ' + info.live);
      ok(info.ghost === 2, '灰态卡 2 张，实测 ' + info.ghost);
      ok(info.h1 === 1, '恰好一个 h1，实测 ' + info.h1);
      ok(info.lang === 'en', 'html lang 正常（实测 ' + info.lang + '）');
      ok(info.mtCreate === 'Create a duel', 'dl.* i18n 键已生效（实测 ' + info.mtCreate + '）', info.mtCreate);
      ok(info.rules === 3, '侧栏规则 3 条由脚本渲染，实测 ' + info.rules);
      ok(info.resumeHidden === true, '无残留时 resume 条隐藏，实测 ' + info.resumeHidden);
      ok(info.small.length === 0, '触摸目标全部 ≥44px', info.small.join(','));
      ok(info.firstHref === '/games/' + g + '/?mode=create', '首卡指向本游戏 create 深链', info.firstHref);
      ok(b.logs.length === 0, '零 console 错误/未捕获异常', b.logs.slice(0, 2).join(' | '));
    }

    /* ── 深链：三种 mode ── */
    console.log('\n=== 深链分派 ===');
    for (const g of GAMES) {
      await b.clearSession();
      await b.goto(BASE + '/games/' + g + '/?mode=join');
      const join = await b.evalJs(`(() => {
        const el = document.getElementById('codeIn');
        return { hasInput: !!el, focused: el ? document.activeElement === el : false,
                 hasCreate: !!document.getElementById('createBtn') };
      })()`);
      ok(join.hasInput, g + ' mode=join 渲染输码框');
      ok(join.focused, g + ' mode=join 自动聚焦输码框', 'focused=' + join.focused);
      ok(join.hasCreate, g + ' mode=join 仍保留建房按钮');

      // 无效 mode → 回大厅
      await b.goto(BASE + '/games/' + g + '/?mode=does-not-exist');
      await sleep(500);
      const back = await b.evalJs('location.pathname');
      ok(back === '/games/' + g + '/lobby/', g + ' 无效 mode 回大厅', back);

      // solo：不应调房间端点，只应渲染单人入口
      await b.clearSession();
      await b.goto(BASE + '/games/' + g + '/?mode=solo');
      await sleep(400);
      const solo = await b.evalJs(`(() => {
        const reqs = (window.__reqs || []);
        return { hasGo: !!document.getElementById('soloGo'),
                 roomCalls: reqs.filter(u => /\\/api\\/md\\/room/.test(u)).length,
                 note: (document.querySelector('.duel-note')||{}).textContent || '' };
      })()`);
      ok(solo.hasGo, g + ' mode=solo 渲染单人开始按钮');
      ok(solo.roomCalls === 0, g + ' mode=solo 未调任何房间端点', 'calls=' + solo.roomCalls);
      ok(/browser|nowhere|记录|record/i.test(solo.note), g + ' mode=solo 明示「不记录」', solo.note.slice(0, 60));
    }

    /* ── 邀请码优先于 mode ── */
    console.log('\n=== ?c= 优先于 ?mode= ===');
    await b.clearSession();
    await b.goto(BASE + '/games/number-recall/?c=ABC234&mode=solo');
    await sleep(600);
    const prio = await b.evalJs(`(() => ({
      url: location.pathname + location.search,
      solo: !!document.getElementById('soloGo'),
      create: !!document.getElementById('createBtn'),
      join: !!document.getElementById('codeIn'),
      err: (document.querySelector('.dc-help.error')||{}).textContent || ''
    }))()`);
    ok(!prio.solo, '?c= 与 ?mode=solo 并存时未进单人模式');
    ok(prio.create || prio.join || prio.err.length > 0, '转入房间/报错路径而非单人', JSON.stringify(prio).slice(0, 120));

    /* ── 移动端视口 ── */
    console.log('\n=== 移动端 390px ===');
    await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    for (const g of ['sequence-memory', 'word-recall']) {
      await b.clearSession();
      await b.goto(BASE + '/games/' + g + '/lobby/');
      const m = await b.evalJs(`(() => {
        const de = document.documentElement;
        const over = de.scrollWidth - de.clientWidth;
        const wide = [];
        document.querySelectorAll('.dc-mode, .dc-btn, .chip, .dc-panel').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.right > window.innerWidth + 1) wide.push(el.className + ' right=' + Math.round(r.right));
        });
        const small = [];
        document.querySelectorAll('a.dc-mode, .back, .btn').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.height > 0 && r.height < 44) small.push(el.className + ':' + Math.round(r.height));
        });
        return { over, wide, small, vw: window.innerWidth };
      })()`);
      ok(m.over <= 1, g + ' 无横向溢出（' + m.over + 'px）');
      ok(m.wide.length === 0, g + ' 无元素超出视口', m.wide.join(' | '));
      ok(m.small.length === 0, g + ' 移动端触摸目标 ≥44px', m.small.join(','));
    }
    await b.send('Emulation.clearDeviceMetricsOverride');

  } finally {
    b.close();
    srv.close();
  }

  console.log('\n=========== ' + pass + ' passed, ' + fail + ' failed ===========');
  if (bad.length) { console.log('\n失败明细：'); bad.forEach((x) => console.log('  - ' + x)); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
