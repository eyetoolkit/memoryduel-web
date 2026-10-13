/**
 * P2 三款新游戏线上真机验收（CDP 无头，线上 www.memoryduel.com）
 * ────────────────────────────────────────────────────────────────
 * 每项都绑定外部可观测事实，不看「没报错」：
 *   A. 大厅：7 张卡（daily + 6 单关）、三张新卡真实点击能跳转
 *   B. 深链：emoji/chimp/word 三个新 mode 均能入局，且进度条只画 1 关
 *   C. 全流程：点「我准备好了」→ 真实作答 → 服务端判分 → 成绩页显示
 *   D. 语言：中文态 word-recall 取到的必须是中文词（英文词 = lang 漏传）
 *   E. 无效 mode 仍回大厅（新增 mode 后兜底没坏）
 *   F. 每页零 console.error / 零未捕获异常
 *
 * 🔴 submit 线上会真写 KV 分数 —— 所以这里**只玩一轮**并接受污染，
 *    用的是匿名临时会话，不影响任何真实玩家。
 *
 * 用法：node tests/p2-live-verify.mjs
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

/* ── 判据 ─────────────────────────────────────────────────── */

// 大厅：模式卡片总数 + 三张新卡
const SNAP_LOBBY = `
  const cards = [...document.querySelectorAll('a[href*="?mode="]')];
  const side = document.getElementById('lvRows');
  return {
    href: location.pathname,
    cards: cards.map((a) => ({
      href: a.getAttribute('href'),
      name: (a.textContent || '').replace(/\\s+/g, ' ').trim(),
      w: Math.round(a.getBoundingClientRect().width),
      h: Math.round(a.getBoundingClientRect().height),
    })),
    sideRows: side ? side.querySelectorAll('.dc-side-row').length : -1,
    sideText: side ? (side.textContent || '').replace(/\\s+/g, ' ').trim() : '',
    bodyLen: (document.body.textContent || '').trim().length,
  };
`;

// 每日挑战入局：三款新关的准备态 DOM 各不相同
const SNAP_DC = `
  const has = (s) => !!document.querySelector(s);
  return {
    path: location.pathname, search: location.search,
    go: has('#go'), row: has('#row'), grid: has('#grid'),
    emojiItems: document.querySelectorAll('.dc-emoji').length,
    opts: document.querySelectorAll('.dc-emoji-opt').length,
    chimpCells: document.querySelectorAll('.dc-chimp-cell').length,
    wordRows: document.querySelectorAll('.dc-word-row').length,
    steps: document.querySelectorAll('.dc-step').length,
    stepText: [...document.querySelectorAll('.dc-step')].map((e) => (e.textContent||'').trim()).join(' / '),
    bodyLen: (document.body.textContent || '').trim().length,
    htmlLang: document.documentElement.lang || '',
  };
`;

/* ── A. 大厅 ──────────────────────────────────────────────── */
async function checkLobby(page) {
  console.log(`\n═══ A. 模式大厅 ═══`);
  page.clearEvents();
  await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/lobby/` });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'));
  await sleep(1200);
  const s = await page.eval(SNAP_LOBBY);

  ok(s.bodyLen > 200, `大厅有实质内容（${s.bodyLen} 字符）`);
  ok(s.cards.length >= 7, `模式卡片 ≥7 张（实测 ${s.cards.length}）`);
  for (const m of ['?mode=daily', '?mode=number', '?mode=sequence', '?mode=color', '?mode=emoji', '?mode=chimp', '?mode=word']) {
    const c = s.cards.find((x) => x.href.includes(m));
    ok(!!c, `卡片存在 ${m}`);
    if (c) {
      ok(c.name.length > 0, `  ${m} 有可访问名`);
      ok(c.w >= 100 && c.h >= 40, `  ${m} 可点区域 ${c.w}×${c.h}`);
    }
  }
  ok(s.sideRows === 3, `侧栏按今日队列渲染 3 行（实测 ${s.sideRows}）`);
  info(`侧栏内容：${s.sideText.slice(0, 90)}`);
  const probs = page.problems();
  ok(probs.length === 0, `大厅零报错${probs.length ? '：' + probs.slice(0, 2).join(' | ') : ''}`);

  // 真实点击新卡
  for (const m of ['emoji', 'chimp', 'word']) {
    const got = await page.eval(`
      const a = [...document.querySelectorAll('a[href*="?mode=${m}"]')][0];
      if (!a) return null;
      a.click();
      return true;`);
    ok(got === true, `真实点击 ${m} 卡片`);
    await page.waitFor(() => page.eval('return location.search.includes("mode=${m}");'), 12000);
    const cur = await page.eval('return location.search;');
    ok(cur.includes(`mode=${m}`), `  跳到 mode=${m}（当前 ${cur}）`);
    page.clearEvents();
    await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/lobby/` });
    await page.waitFor(() => page.eval('return document.readyState === "complete";'));
    await sleep(800);
  }
}

/* ── B/C. 三款新游戏全流程 ────────────────────────────────── */
async function checkEmoji(page) {
  console.log(`\n═══ B. Emoji Ghost /?mode=emoji ═══`);
  page.clearEvents();
  await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=emoji` });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'));
  await page.waitFor(() => page.eval('return !!document.querySelector("#go");'), 20000);
  await sleep(600);

  let s = await page.eval(SNAP_DC);
  ok(s.go, '准备态出现「我准备好了」');
  ok(s.steps === 1, `单关模式进度条只画 1 关（实测 ${s.steps}："${s.stepText}"）`);
  ok(s.bodyLen > 60, `准备态有实质内容（${s.bodyLen} 字符）`);

  // 点开始 → emoji 应闪现
  await page.eval('document.querySelector("#go").click();');
  const flashed = await page.waitFor(() => page.eval('return document.querySelectorAll(".dc-emoji").length > 0;'), 6000);
  ok(flashed, '点击后集合闪现');
  await sleep(900);
  const n = await page.eval('return document.querySelectorAll(".dc-emoji").length;');
  info(`闪现集合 ${n} 个 emoji`);
  const goHidden = await page.eval(`
    const g = document.querySelector("#go");
    return !g || g.disabled || g.style.display === 'none';`);
  ok(goHidden, '「我准备好了」点击后已停用/隐藏（不能点了没反应）');

  // 等四选一出现（预览 3.4s）
  const optsShown = await page.waitFor(() => page.eval('return document.querySelectorAll(".dc-emoji-opt").length === 4;'), 12000);
  ok(optsShown, '四选一选项出现');
  if (!optsShown) return;

  s = await page.eval(SNAP_DC);
  ok(s.opts === 4, `恰好 4 个选项（${s.opts}）`);
  const optInfo = await page.eval(`
    return [...document.querySelectorAll('.dc-emoji-opt')].map(b => ({
      i: b.dataset.i, t: (b.textContent||'').trim(), aria: b.getAttribute('aria-checked'),
      w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height),
    }));`);
  info('选项：' + optInfo.map((o) => o.t).join(' '));
  for (const o of optInfo) {
    ok(o.w >= 44 && o.h >= 44, `  选项 ${o.i} 触摸目标 ${o.w}×${o.h} ≥44`);
  }
  // 真实点第一个选项 → 判分页
  await page.eval(`document.querySelectorAll('.dc-emoji-opt')[0].click();`);
  const scored = await page.waitFor(() => page.eval(`return !!document.querySelector('#nextBtn');`), 15000);
  ok(scored, '提交后进入成绩页');
  if (scored) {
    // 🔴 必须 trim：成绩节点由多行模板字符串生成，textContent 带换行与缩进
    const r = await page.eval(`
      return { score: ((document.querySelector('.dc-result-score')||{}).textContent||'').trim(),
               of: ((document.querySelector('.dc-result-of')||{}).textContent||'').trim() };`);
    info(`成绩：${r.score} ${r.of}`);
    ok(/^\\d+$/.test((r.score || '').trim()), '  分数为数字（服务端判分）');
    ok(/of\\s*10/.test(r.of || ''), '  单轮满分是 10（不是三关总分 74）');
  }
  const probs = page.problems();
  ok(probs.length === 0, `零报错${probs.length ? '：' + probs.slice(0, 2).join(' | ') : ''}`);
}

async function checkChimp(page) {
  console.log(`\n═══ C. Chimp Test /?mode=chimp ═══`);
  page.clearEvents();
  await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=chimp` });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'));
  await page.waitFor(() => page.eval('return !!document.querySelector("#go");'), 20000);
  await sleep(600);

  let s = await page.eval(SNAP_DC);
  ok(s.go, '准备态出现「我准备好了」');
  ok(s.steps === 1, `进度条只画 1 关（实测 ${s.steps}）`);

  await page.eval('document.querySelector("#go").click();');
  const flashed = await page.waitFor(() => page.eval('return document.querySelectorAll(".dc-chimp-cell.lit").length > 0;'), 6000);
  ok(flashed, '点击后数字在网格闪现');
  const cells = await page.eval('return document.querySelectorAll(".dc-chimp-cell").length;');
  ok(cells === 25, `5×5 = 25 格（实测 ${cells}）`);

  // 等数字消失、进入作答态
  const answered = await page.waitFor(() => page.eval(`return !!document.querySelector('#go2');`), 20000);
  ok(answered, '进入作答态（出现「完成」按钮）');
  if (!answered) return;
  s = await page.eval(SNAP_DC);
  const cellSz = await page.eval(`
    const c = document.querySelector('.dc-chimp-cell');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };`);
  info(`格子尺寸 ${cellSz && cellSz.w}×${cellSz && cellSz.h}`);
  ok(cellSz && cellSz.w >= 40 && cellSz.h >= 40, '格子触摸目标 ≥40px');

  // 真实点 5 格后提交
  await page.eval(`
    const cs = [...document.querySelectorAll('.dc-chimp-cell')].slice(0, 5);
    for (const c of cs) c.click();`);
  await sleep(300);
  const picked = await page.eval(`return document.querySelectorAll('.dc-chimp-cell.lit, .dc-chimp-cell.wrong').length;`);
  ok(picked === 5, `点了 5 格都有反馈（实测 ${picked}）`);

  await page.eval(`document.querySelector('#go2').click();`);
  const scored = await page.waitFor(() => page.eval(`return !!document.querySelector('#nextBtn');`), 15000);
  ok(scored, '提交后进入成绩页');
  if (scored) {
    // 🔴 必须 trim：成绩节点由多行模板字符串生成，textContent 带换行与缩进
    const r = await page.eval(`
      return { score: ((document.querySelector('.dc-result-score')||{}).textContent||'').trim(),
               of: ((document.querySelector('.dc-result-of')||{}).textContent||'').trim() };`);
    info(`成绩：${r.score} ${r.of}`);
    ok(/^\\d+$/.test((r.score || '').trim()), '分数为数字');
    ok(/of\\s*5/.test(r.of || ''), '第 1 轮满分是 5（不是关卡 18）');
  }
  const probs = page.problems();
  ok(probs.length === 0, `零报错${probs.length ? '：' + probs.slice(0, 2).join(' | ') : ''}`);
}

async function checkWord(page) {
  console.log(`\n═══ D. Word Recall /?mode=word（中文态）═══`);
  page.clearEvents();
  // 先切中文，验证 lang 真的生效
  await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=word` });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'));
  await page.eval(`
    try { localStorage.setItem('md_lang', 'zh'); } catch (_) {}
    document.documentElement.setAttribute('lang', 'zh');`);
  await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=word` });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'));
  await page.waitFor(() => page.eval('return !!document.querySelector("#go");'), 20000);
  await sleep(600);

  let s = await page.eval(SNAP_DC);
  ok(s.htmlLang === 'zh', `html lang = zh（实测 ${s.htmlLang}）`);
  ok(s.go, '准备态出现「我准备好了」');
  ok(s.steps === 1, `进度条只画 1 关（实测 ${s.steps}）`);

  await page.eval('document.querySelector("#go").click();');
  const flashing = await page.waitFor(() => page.eval('return (document.querySelector("#now")||{}).textContent !== "";'), 8000);
  ok(flashing, '点击后词语逐个闪现');
  const firstWord = await page.eval('return (document.querySelector("#now")||{}).textContent || "";');
  info(`首个闪现词：${firstWord}`);
  ok(/[一-龥]/.test(firstWord), `  闪现有中文词（"${firstWord}"）—— lang 生效`);

  const rows = await page.waitFor(() => page.eval('return document.querySelectorAll(".dc-word-row").length > 0;'), 25000);
  ok(rows, '进入逐词判定态');
  if (!rows) return;
  s = await page.eval(SNAP_DC);
  ok(s.wordRows === 6, `第 1 轮 6 个词（实测 ${s.wordRows}）`);

  const words = await page.eval(`
    return [...document.querySelectorAll('.dc-word-row .w')].map(e => (e.textContent||'').trim());`);
  info('判定列表：' + words.join(' / '));
  ok(words.every((w) => /[一-龥]/.test(w)), '  全部是中文词');

  // 全部标 New 后提交
  await page.eval(`
    [...document.querySelectorAll('.dc-word-btn[data-v="new"]')].forEach(b => b.click());`);
  await sleep(300);
  const answered = await page.eval(`return document.querySelectorAll('.dc-word-row.answered').length;`);
  ok(answered === 6, `6 词都已作答（实测 ${answered}）`);
  const btnSz = await page.eval(`
    const b = document.querySelector('.dc-word-btn');
    if (!b) return null; const r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };`);
  ok(btnSz && btnSz.h >= 44, `按钮触摸目标高 ${btnSz && btnSz.h} ≥44`);

  await page.eval(`document.querySelector('#lock').click();`);
  const scored = await page.waitFor(() => page.eval(`return !!document.querySelector('#nextBtn');`), 15000);
  ok(scored, '提交后进入成绩页');
  if (scored) {
    // 🔴 必须 trim：成绩节点由多行模板字符串生成，textContent 带换行与缩进
    const r = await page.eval(`
      return { score: ((document.querySelector('.dc-result-score')||{}).textContent||'').trim(),
               of: ((document.querySelector('.dc-result-of')||{}).textContent||'').trim() };`);
    info(`成绩：${r.score} ${r.of}`);
    ok(/^\\d+$/.test((r.score || '').trim()), '分数为数字');
    ok(/of\\s*6/.test(r.of || ''), '第 1 轮满分是 6（不是关卡 30）');
  }
  const probs = page.problems();
  ok(probs.length === 0, `零报错${probs.length ? '：' + probs.slice(0, 2).join(' | ') : ''}`);
}

/* ── E. 兜底与每日轮换 ────────────────────────────────────── */
async function checkFallback(page) {
  console.log(`\n═══ E. 无效 mode 兜底 + 每日轮换 ═══`);
  page.clearEvents();
  await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=bogus` });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'));
  const back = await page.waitFor(() => page.eval('return location.pathname.includes("/lobby/");'), 12000);
  ok(back, '无效 mode 被 replace 回大厅');
  await sleep(900);
  const s = await page.eval(SNAP_LOBBY);
  ok(s.bodyLen > 200, `大厅正常渲染（${s.bodyLen} 字符），未白屏`);
  ok(s.cards.length >= 7, `大厅卡片完整（${s.cards.length} 张）`);

  // 每日挑战走服务端队列：进度条应为 3 关
  page.clearEvents();
  await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=daily` });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'));
  await page.waitFor(() => page.eval('return !!document.querySelector("#go");'), 20000);
  await sleep(600);
  const d = await page.eval(SNAP_DC);
  ok(d.steps === 3, `每日挑战进度条 3 关（实测 ${d.steps}）`);
  info(`今日队列：${d.stepText}`);
  const probs = page.problems();
  ok(probs.length === 0, `零报错${probs.length ? '：' + probs.slice(0, 2).join(' | ') : ''}`);
}

/* ── main ─────────────────────────────────────────────────── */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'md-p2-'));
const port = 9331 + Math.floor(Math.random() * 200);
const proc = spawn(EXE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=390,844', '--lang=zh-CN', 'about:blank',
], { stdio: 'ignore' });

let page;
try {
  page = await CDP.attach(port);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');

  await checkLobby(page);
  await checkEmoji(page);
  await checkChimp(page);
  await checkWord(page);
  await checkFallback(page);
} catch (e) {
  fail++;
  console.log(`\n  FAIL 脚本异常：${e.message}`);
} finally {
  try { proc.kill(); } catch (_) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);