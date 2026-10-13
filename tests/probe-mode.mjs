/* 取证：mode= 深链为何没渲染出游戏 DOM */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ORIGIN = 'https://www.memoryduel.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 9840 + (process.pid % 200);
const PROFILE = path.join(os.tmpdir(), 'md-probe-' + process.pid);
fs.mkdirSync(PROFILE, { recursive: true });
const edge = spawn(EXE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--no-first-run',
  '--no-proxy-server', '--disable-extensions', `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

let ws;
try {
  let list = null;
  for (let i = 0; i < 60; i++) {
    try { list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); if (list) break; } catch (_) {}
    await sleep(200);
  }
  ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waits = new Map(); const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
    else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  };
  const send = (method, params = {}) => { const i = ++id; return new Promise((r, j) => { waits.set(i, (m) => m.error ? j(new Error(m.error.message)) : r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); }); };
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  for (const url of [
    `${ORIGIN}/games/daily-challenge/?mode=emoji`,
    `${ORIGIN}/games/daily-challenge/?mode=chimp`,
    `${ORIGIN}/games/daily-challenge/?mode=word`,
  ]) {
    logs.length = 0;
    await send('Page.navigate', { url });
    await sleep(3000);
    const s = await ev(`
      const q=(x)=>document.querySelectorAll(x).length;
      const card=document.getElementById('card');
      return {
        url: location.href.slice(0,90),
        htmlLang: document.documentElement.lang,
        i18nReady: document.documentElement.getAttribute('data-i18n-ready'),
        hasClient: !!window.DailyClient,
        h2: card ? (card.querySelector('.dc-h2')||{}).textContent : '(no #card)',
        emoji: q('.dc-emoji'), opts: q('.dc-emoji-opt'),
        chimp: q('.dc-chimp-cell'), word: q('.dc-word-row'),
        seq: q('.dc-seq-cell'), steps: q('.dc-step'),
        btns: [...document.querySelectorAll('button')].map(b=>(b.textContent||'').replace(/\\s+/g,' ').trim()).slice(0,10),
        cardText: card ? (card.textContent||'').replace(/\\s+/g,' ').trim().slice(0,140) : '',
      };`);
    console.log('\n### ' + url);
    console.log(JSON.stringify(s, null, 1));
    if (logs.length) console.log('LOGS: ' + logs.slice(0, 5).join(' || '));
  }
} finally {
  try { edge.kill(); } catch (_) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
}