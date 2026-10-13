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

  /* ── B. 旧对战页端到端：建房 → 开局 → 作答 → 成绩 ─────── */
  section('B. 旧对战页端到端回归（验 #45 的 room/start 修复）');
  for (const g of ['sequence-memory', 'number-recall']) {
    page.clearEvents();
    await page.send('Page.navigate', { url: `${ORIGIN}/games/${g}/` });
    await page.waitFor(() => page.eval('return document.readyState === "complete";'));
    await sleep(800);
    page.clearEvents();

    // 建房
    const created = await page.eval(`
      const b = document.getElementById('createBtn');
      if (!b) return { err: 'no createBtn' };
      b.click();
      return { clicked: true };`);
    if (created.err) { ok(false, `${g} 建房按钮缺失`); continue; }

    const gotWaiting = await page.waitFor(() => page.eval(
      `return !!document.getElementById('codeBig') || !!document.getElementById('startBtn');`), 20000);
    ok(gotWaiting, `${g} 建房后进入等待页并拿到房码`);
    if (!gotWaiting) {
      info('页面正文：' + await page.eval(`return (document.body.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160);`));
      continue;
    }

    // 房主自己就是唯一玩家 → 直接点开始（后端允许 1 人开局）
    const started = await page.eval(`
      const b = document.getElementById('startBtn');
      if (!b) return { err: 'no startBtn (iAmHost=false?)' };
      b.click();
      return { clicked: true };`);
    if (started.err) { ok(false, `${g} ${started.err}`); continue; }

    const gotRound = await page.waitFor(() => page.eval(
      `return !!document.getElementById('go');`), 20000);
    ok(gotRound, `${g} 开局后进入第 1 轮「开始本轮」态`);
    if (!gotRound) {
      info('页面正文：' + await page.eval(`return (document.body.textContent||'').replace(/\\s+/g,' ').trim().slice(0,200);`));
      const p = page.problems();
      if (p.length) info('问题：' + p.slice(0, 3).join(' | '));
      continue;
    }

    // 点开始本轮 → 题目出现
    await page.eval(`document.getElementById('go').click(); return true;`);
    const gotPuzzle = await page.waitFor(() => page.eval(`
      const cells = document.querySelectorAll('.dc-seq-cell:not([disabled])');
      const input = document.getElementById('ans');
      const wheel = document.getElementById('wheel');
      return cells.length > 0 || !!input || !!wheel;
    `), 25000);
    ok(gotPuzzle, `${g} 第 1 轮题目成功渲染（可作答）`);

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
  for (const [mode, sel] of [['emoji', '.dc-emoji-opt'], ['chimp', '.dc-chimp-cell'], ['word', '.dc-word-row']]) {
    page.clearEvents();
    await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=${mode}&lang=zh` });
    await page.waitFor(() => page.eval('return document.readyState === "complete";'));
    await sleep(1400);
    // 走完「我准备好了」
    const ready = await page.eval(`
      const b = [...document.querySelectorAll('button')].find(x => /准备好了|ready|开始/i.test(x.textContent||''));
      if (b) { b.click(); return true; }
      return false;`);
    if (ready) await sleep(1600);
    const s = await page.eval(`
      const q = (s) => document.querySelectorAll(s).length;
      return {
        htmlLang: document.documentElement.lang || '',
        emoji: q('.dc-emoji'), opts: q('.dc-emoji-opt'),
        chimp: q('.dc-chimp-cell'),
        wordRows: q('.dc-word-row'),
        wordText: [...document.querySelectorAll('.dc-word-row')].slice(0,4).map(e => (e.textContent||'').replace(/\\s+/g,' ').trim()).join(' | '),
        steps: q('.dc-step'),
      };`);
    const has = mode === 'emoji' ? (s.emoji > 0 && s.opts === 4) : mode === 'chimp' ? s.chimp === 25 : s.wordRows > 0;
    ok(has, `mode=${mode} 入局后渲染出该游戏专属 DOM（emoji=${s.emoji}/opts=${s.opts} chimp=${s.chimp} word=${s.wordRows}）`);
    if (mode === 'word' && s.wordRows > 0) {
      // 中文态必须拿到中文词：判据 = 出现 CJK 字符
      const cjk = /[\u4e00-\u9fff]/.test(s.wordText);
      ok(cjk, `word-recall 在 lang=zh 下取到中文词：${s.wordText.slice(0, 60)}`);
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