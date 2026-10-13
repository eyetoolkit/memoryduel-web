/**
 * 三款新游戏对战链路审核（CDP 无头，线上 www.memoryduel.com）
 * ────────────────────────────────────────────────────────────
 * 背景：审核三款新游戏时发现两处硬伤
 *   ① /room/start 记忆分支 ReferenceError → 六款记忆游戏全部开不了局（已修）
 *   ② emoji-ghost / chimp-test / word-recall **没有对战页**
 *      （games/ 下只有 sequence/number/color 三个目录，vite input 也只注册这三个）
 *
 * 本脚本按「页面能不能走通」验收，不看「没报错」：
 *   A. 已上线三款对战页：建房 → 开局 → 逐轮作答 → 成绩页（回归 #45）
 *   B. 三款新游戏：确认是否存在独立对战页（当前预期为「无」，记录为已知缺口）
 *   C. 每日挑战里的三款新游戏：深链 + 完整流程 + 中文语言一致性
 *   D. lobby 侧栏是否按今日队列动态渲染
 *   E. 每页零 console.error / 零未捕获异常
 *
 * 用法：node tests/audit-duel-verify.mjs
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
      this.waits.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
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
        const t = e.params.entry.text || '';
        if (/status of 4\d\d/.test(t)) continue;
        out.push('资源错误: ' + t + ' ' + (e.params.entry.url || ''));
      }
    }
    return out;
  }
  async waitFor(fn, timeout = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await fn()) return true; } catch (_) {}
      await sleep(200);
    }
    return false;
  }
  clearEvents() { this.events.length = 0; }
}

/* ── 启动浏览器 ───────────────────────────────────────────── */
const PORT = 9540 + (process.pid % 300);
const PROFILE = path.join(os.tmpdir(), 'md-duel-audit-' + process.pid);
fs.mkdirSync(PROFILE, { recursive: true });
const edge = spawn(EXE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', `--user-data-dir=${PROFILE}`,
  // 🔴 2026-10-13：本机系统代理开着，无头 Edge 会自动继承 → 全部请求
  // ERR_PROXY_CONNECTION_FAILED，页面落地成 Chrome 的「代理出错」页，
  // 表现为「所有页面 bodyLen=1927、没有任何游戏 DOM」—— 极易误判成站点挂了。
  // 验收脚本一律显式关代理。
  '--no-proxy-server',
  'about:blank',
], { stdio: 'ignore', detached: false });

let page;
try {
  page = await CDP.attach(PORT);
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');

  /* ── A. 三款新游戏是否有独立对战页 ────────────────────── */
  section('A. 三款新游戏的对战页是否存在');
  const NEW_GAMES = ['emoji-ghost', 'chimp-test', 'word-recall'];
  const OLD_GAMES = ['sequence-memory', 'number-recall', 'color-recall'];

  for (const g of OLD_GAMES) {
    page.clearEvents();
    await page.send('Page.navigate', { url: `${ORIGIN}/games/${g}/` });
    await page.waitFor(() => page.eval('return document.readyState === "complete";'));
    await sleep(900);
    const s = await page.eval(`
      return {
        path: location.pathname,
        hasCreate: !!document.getElementById('createBtn'),
        hasJoin: !!document.getElementById('joinBtn'),
        bodyLen: (document.body.textContent||'').trim().length,
        title: (document.querySelector('.dc-h2')||{}).textContent || '',
      };`);
    ok(s.hasCreate && s.hasJoin, `旧对战页 ${g} 渲染出建房+加入入口`);
    if (s.bodyLen < 120) info(`⚠ ${g} bodyLen=${s.bodyLen} 疑似软 404`);
  }

  for (const g of NEW_GAMES) {
    page.clearEvents();
    const r = await fetch(`${ORIGIN}/games/${g}/`, { redirect: 'manual' }).catch(() => null);
    let status = 'ERR';
    if (r) status = String(r.status);
    page.clearEvents();
    await page.send('Page.navigate', { url: `${ORIGIN}/games/${g}/` });
    await page.waitFor(() => page.eval('return document.readyState === "complete";'));
    await sleep(900);
    const s = await page.eval(`
      return {
        path: location.pathname,
        hasCreate: !!document.getElementById('createBtn'),
        bodyLen: (document.body.textContent||'').trim().length,
        head: (document.body.textContent||'').replace(/\\s+/g,' ').trim().slice(0,90),
      };`);
    const exists = s.hasCreate && s.bodyLen > 200;
    ok(exists, `新游戏 ${g} 有独立对战页`);
    if (!exists) {
      info(`⚠ 缺口：${g} 无对战页（HTTP ${status}，落地 ${s.path}，正文首 90 字「${s.head}」）`);
    }
  }

  /* ── B. 六款对战页端到端：建房 → 开局 → 逐轮作答 → 成绩 ──── */
  section('B. 六款对战页端到端（验 #45 room/start 修复 + #46 新对战页）');
  /* 判据：每款都必须能建房、拿到房码、点开始进入第 1 轮、
     且取到题目后渲染出**该游戏专属**的可作答 DOM。
     ⚠️ 必须等题目真的渲染出来，不能只看「没报错」——
        start 失败时页面也会渲染出一张错误卡，同样零 console.error。 */
  const DUEL_SEL = {
    'sequence-memory': 'cells',       // .dc-seq-cell:not([disabled])
    'number-recall': 'input',         // #ans
    'color-recall': 'wheel',          // #wheel
    'emoji-ghost': 'emojiopts',       // .dc-emoji-opt
    'chimp-test': 'chimpdone',        // #done（数字已闪现完毕，等点格）
    'word-recall': 'wordlock',        // #lock
  };
  for (const g of [...OLD_GAMES, ...NEW_GAMES]) {
    page.clearEvents();
    await page.send('Page.navigate', { url: `${ORIGIN}/games/${g}/` });
    await page.waitFor(() => page.eval('return document.readyState === "complete";'));
    await sleep(900);

    const hasCreate = await page.eval(`return !!document.getElementById('createBtn');`);
    if (!hasCreate) { ok(false, `${g} 建房按钮缺失`); continue; }

    await page.eval(`document.getElementById('createBtn').click(); return true;`);
    const gotWaiting = await page.waitFor(() => page.eval(
      `return !!document.getElementById('codeBig') || !!document.getElementById('startBtn');`), 20000);
    ok(gotWaiting, `${g} 建房后进入等待页并拿到房码`);
    if (!gotWaiting) {
      info('页面正文：' + await page.eval(`return (document.body.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160);`));
      continue;
    }

    const hasStart = await page.eval(`return !!document.getElementById('startBtn');`);
    if (!hasStart) { ok(false, `${g} 房主看不到「开始对决」按钮（iAmHost 判定失败）`); continue; }
    await page.eval(`document.getElementById('startBtn').click(); return true;`);

    const gotRound = await page.waitFor(() => page.eval(
      `return !!document.getElementById('go');`), 20000);
    ok(gotRound, `${g} 开局后进入第 1 轮「开始本轮」态`);
    if (!gotRound) {
      info('页面正文：' + await page.eval(`return (document.body.textContent||'').replace(/\\s+/g,' ').trim().slice(0,200);`));
      const p0 = page.problems();
      if (p0.length) info('问题：' + p0.slice(0, 3).join(' | '));
      continue;
    }

    await page.eval(`document.getElementById('go').click(); return true;`);
    const sel = DUEL_SEL[g];
    const gotPuzzle = await page.waitFor(() => page.eval(`
      switch ('${sel}') {
        case 'cells':      return document.querySelectorAll('.dc-seq-cell:not([disabled])').length > 0;
        case 'input':      return !!document.getElementById('ans');
        case 'wheel':      return !!document.getElementById('wheel');
        case 'emojiopts':   return document.querySelectorAll('.dc-emoji-opt').length === 4;
        case 'chimpdone':   return !!document.getElementById('done');
        case 'wordlock':    return !!document.getElementById('lock');
        default: return false;
      }`), 30000);
    ok(gotPuzzle, `${g} 第 1 轮题目成功渲染并可作答`);

    const probs = page.problems();
    ok(probs.length === 0, `${g} 对战流程零 console.error / 零未捕获异常`);
    if (probs.length) info('问题：' + probs.slice(0, 3).join(' | '));
  }

  /* ── C. lobby 侧栏按今日队列动态渲染 ──────────────────── */
  section('C. 大厅侧栏与今日队列');
  page.clearEvents();
  await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/lobby/` });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'));
  await sleep(1500);
  const lobby = await page.eval(`
    const side = document.getElementById('lvRows');
    return {
      cards: document.querySelectorAll('a[href*="?mode="]').length,
      sideRows: side ? side.querySelectorAll('.dc-side-row').length : -1,
      sideText: side ? (side.textContent||'').replace(/\\s+/g,' ').trim() : '',
      hasIdLeak: /\\b(number-recall|sequence-memory|color-recall|emoji-ghost|chimp-test|word-recall)\\b/.test(side ? side.textContent : ''),
    };`);
  ok(lobby.cards === 7, `lobby 有 7 张模式卡（实际 ${lobby.cards}）`);
  ok(lobby.sideRows >= 3, `侧栏按今日队列渲染出 ${lobby.sideRows} 行`);
  ok(!lobby.hasIdLeak, '侧栏没有暴露原始游戏 id');
  info(`侧栏文案：${lobby.sideText.slice(0, 120)}`);

  /* ── D. 三款新游戏每日深链 + 中文语言一致性 ────────────── */
  section('D. 三款新游戏每日深链');
  /* 🔴 判据必须绑定**语言无关的结构特征**，不能匹配按钮文案：
     上一版用 /准备好了|ready|开始/i 找按钮，而英文态文案是 "Show me"、
     中文态是「开始」—— 两种都匹配不到/误匹配，导致三款全部假失败，
     差点被当成「深链坏了」去改本来正确的 resolveMode 逻辑。
     正确做法：直接查「点开始后该游戏专属 DOM 是否出现」。 */
  const DAILY_SEL = {
    emoji: { js: 'document.querySelectorAll(".dc-emoji-opt").length === 4', chk: (s) => s.emoji > 0 && s.opts === 4 },
    chimp: { js: 'document.querySelectorAll(".dc-chimp-cell").length === 25', chk: (s) => s.chimp === 25 },
    word:  { js: '!!document.getElementById("lock")', chk: (s) => s.wordRows > 0 },
  };
  for (const mode of ['emoji', 'chimp', 'word']) {
    page.clearEvents();
    await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=${mode}` });
    await page.waitFor(() => page.eval('return document.readyState === "complete";'));
    await sleep(1600);

    // 先预置 zh，走真实中文玩家路径
    await page.eval(`try{localStorage.setItem('memoryduel_lang','zh');localStorage.setItem('lang','zh');}catch(e){} return true;`);
    await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=${mode}&lang=zh` });
    await page.waitFor(() => page.eval('return document.readyState === "complete";'));
    await sleep(2200);

    // 结构化的「开始」按钮：取 #card 内第一个 button（不含 aria-hidden）
    const clicked = await page.eval(`
      const b = document.querySelector('#card button:not([aria-hidden])');
      if (!b) return false;
      b.click(); return true;`);
    ok(clicked, `mode=${mode} 入局后出现「开始」按钮`);

    const got = await page.waitFor(() => page.eval(DAILY_SEL[mode].js), 30000);
    const s = await page.eval(`
      const q = (x) => document.querySelectorAll(x).length;
      const card = document.getElementById('card');
      return {
        htmlLang: document.documentElement.lang || '',
        emoji: q('.dc-emoji'), opts: q('.dc-emoji-opt'),
        chimp: q('.dc-chimp-cell'),
        wordRows: q('.dc-word-row'),
        wordText: [...document.querySelectorAll('.dc-word-row .w')].slice(0,4).map(e => (e.textContent||'').trim()).join(' | '),
        cardText: card ? (card.textContent||'').replace(/\\s+/g,' ').trim().slice(0,110) : '',
      };`);
    ok(got, `mode=${mode} 题目渲染成功（emoji=${s.emoji}/${s.opts} chimp=${s.chimp} word=${s.wordRows}）`);
    ok(s.htmlLang === 'zh', `mode=${mode} 落在中文态（html lang=${s.htmlLang}）`);
    ok(!/Emoji Ghost|Chimp Test|Word Recall/.test(s.cardText),
      `mode=${mode} 中文态无英文兜底文案：「${s.cardText.slice(0, 70)}」`);
    if (mode === 'word' && s.wordRows > 0) {
      const cjk = /[\u4e00-\u9fff]/.test(s.wordText);
      ok(cjk, `word-recall 在 lang=zh 下取到中文词：${s.wordText.slice(0, 50)}`);
    }
    const p = page.problems();
    ok(p.length === 0, `mode=${mode} 零 console.error / 零未捕获异常`);
    if (p.length) info('问题：' + p.slice(0, 2).join(' | '));
  }

  /* ── E. 无效 mode 兜底 ────────────────────────────────── */
  section('E. 无效 mode 兜底');
  page.clearEvents();
  await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=zzz-not-a-game` });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'));
  await sleep(1400);
  const bad = await page.eval(`
    return {
      bodyLen: (document.body.textContent||'').trim().length,
      hasError: /error|出错了|Something went wrong/i.test(document.body.textContent||''),
      path: location.pathname,
    };`);
  ok(bad.bodyLen > 150, `无效 mode 有内容响应（bodyLen=${bad.bodyLen}，非软 404）`);
  ok(!bad.hasError, '无效 mode 不弹错误卡');

} finally {
  try { edge.kill(); } catch (_) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
}

console.log(`\n─────────────────────────────────────────`);
console.log(`结果: ${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项`);
process.exit(fail ? 1 : 0);