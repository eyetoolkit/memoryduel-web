/* 取证：i18n 字典未就绪时页面就用英文兜底渲染，且不会被 i18n 事后修正 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ORIGIN = 'https://www.memoryduel.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 9700 + (process.pid % 200);
const PROFILE = path.join(os.tmpdir(), 'md-i18n-' + process.pid);
fs.mkdirSync(PROFILE, { recursive: true });
const edge = spawn(EXE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--no-first-run',
  '--no-proxy-server', '--disable-extensions', `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

try {
  let list = null;
  for (let i = 0; i < 60; i++) {
    try { list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); if (list) break; } catch (_) {}
    await sleep(200);
  }
  const ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waits = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } };
  const send = (method, params = {}) => { const i = ++id; return new Promise((r, j) => { waits.set(i, (m) => m.error ? j(new Error(m.error.message)) : r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); }); };
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');

  // 预置 localStorage = zh（模拟真实用户已选中文）
  await send('Page.navigate', { url: `${ORIGIN}/` });
  await sleep(2500);
  await ev(`try{localStorage.setItem('md_lang','zh');localStorage.setItem('memoryduel_lang','zh');}catch(e){}
            return Object.keys(localStorage).filter(k=>/lang/i.test(k)).map(k=>k+'='+localStorage.getItem(k)).join(',');`)
    .then((r) => console.log('localStorage lang keys: ' + r));

  // 反复刷新 lobby，看侧栏是否稳定泄露 id
  let leak = 0, total = 0;
  for (let i = 0; i < 6; i++) {
    await send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/lobby/` });
    await sleep(2600);
    const s = await ev(`
      const side=document.getElementById('lvRows');
      const txt=side?(side.textContent||'').replace(/\\s+/g,' ').trim():'';
      return { lang:document.documentElement.lang, ready:document.documentElement.getAttribute('data-i18n-ready'),
               rows: side?side.querySelectorAll('.dc-side-row').length:-1, txt:txt.slice(0,110),
               leaked: /\\b(emoji-ghost|chimp-test|word-recall|number-recall|sequence-memory|color-recall)\\b/.test(txt) };`);
    total++;
    if (s.leaked) leak++;
    console.log(`[${i + 1}] lang=${s.lang} ready=${s.ready} rows=${s.rows} leaked=${s.leaked}  ${s.txt}`);
    await sleep(400);
  }
  console.log(`\n=> 侧栏泄露 id 命中率 ${leak}/${total}`);

  // 同样测每日挑战 mode=word 在中文态下的文案
  await send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=word` });
  await sleep(3000);
  const g = await ev(`
    const card=document.getElementById('card');
    return { lang:document.documentElement.lang,
             h2:(card?card.querySelector('.dc-h2'):{}).textContent,
             help:(card?card.querySelector('.dc-help'):{}).textContent,
             btn:[...document.querySelectorAll('#card button')].map(b=>(b.textContent||'').trim()).join('|') };`);
  console.log('\n每日挑战 mode=word（localStorage=zh）：' + JSON.stringify(g, null, 1));
} finally {
  try { edge.kill(); } catch (_) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
}