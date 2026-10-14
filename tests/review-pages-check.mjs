/**
 * 新上线游戏页面全量核查（线上真站点，CDP 无头）
 * ────────────────────────────────────────────────────────────────
 * 覆盖每日挑战页 + 大厅页 + **games/ 下全部对战页**（目录派生，加游戏自动纳入）：
 *   /games/daily-challenge/          ?mode=daily|number|sequence|color|emoji|chimp|word
 *   /games/daily-challenge/lobby/    模式选择大厅
 *   /games/<slug>/                   sequence / number / color / emoji / chimp / word
 *
 * 每项都绑定外部可观测事实，不看「没报错」：
 *   A. lobby：模式卡片存在、href 精确、有可访问名、真实点击能跳到对应 ?mode=
 *   B. 深链：各mode 均能入局（出现游戏主体 DOM 且 URL 未被弹回大厅）
 *   C. 兜底：无效 mode 必须 replace 回大厅且大厅正常渲染（不得白屏/半死）
 *   D. 邀请码优先：?c= 必须带到大厅（?c= 优先于 ?mode=）
 *   E. 对战页：入口 UI 出现（建房/房码/加入），无 c= 时不静默失败
 *   F. 每页：零 console.error / 零未捕获异常 / 零资源错误 / html lang 与语言一致
 *
 * 用法：node tests/review-pages-check.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ORIGIN = process.env.MD_ORIGIN || 'https://www.memoryduel.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => {
  if (c) { pass++; console.log(`  ok   ${m}`); }
  else { fail++; console.log(`  FAIL ${m}`); }
};
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
        const t = en.text || '';
        // 4xx 是后端正常业务响应（如房码不存在 404），不算资源错误
        if (/status of 4\d\d/.test(t)) continue;
        out.push('资源错误: ' + t + ' ' + (en.url || ''));
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

/* ── 判据快照 ─────────────────────────────────────────────── */

// lobby 页：4 张模式卡片
const SNAP_LOBBY = `
  const cards = [...document.querySelectorAll('a[href*="?mode="]')];
  return {
    href: location.pathname,
    cards: cards.map((a) => ({
      href: a.getAttribute('href'),
      name: (a.textContent || '').replace(/\\s+/g, ' ').trim(),
      w: Math.round(a.getBoundingClientRect().width),
      h: Math.round(a.getBoundingClientRect().height),
    })),
    bodyLen: (document.body.textContent || '').trim().length,
  };
`;

// 每日挑战入局判据。
// 🔴 三关的**准备态** DOM 形态不同（游戏主体要等玩家点「我准备好了」后才渲染）：
//    number-recall   → #ans（数字输入框，准备态就在）
//    sequence-memory → #grid（格子，准备态就在）
//    color-recall    → #row（预览色块容器）+ #go（色轮 #wheel 要到还原阶段才出现）
//    统一再认一个 #go：「我准备好了」按钮存在 = 关卡已就绪、深链解析成功。
const SNAP_DC = `
  const has = (s) => !!document.querySelector(s);
  return {
    path: location.pathname,
    search: location.search,
    ans: has('#ans'), grid: has('#grid'), row: has('#row'), go: has('#go'),
    wheel: has('#wheel'), sliders: has('#h') && has('#s') && has('#b'),
    steps: document.querySelectorAll('.dc-step').length,
    stepText: [...document.querySelectorAll('.dc-step')].map((e) => (e.textContent || '').trim()).join(' / '),
    bodyLen: (document.body.textContent || '').trim().length,
    title: document.title,
  };
`;

// 对战页入口判据：建房 / 房码 / 加入 三件套
const SNAP_DUEL = `
  const has = (s) => !!document.querySelector(s);
  return {
    path: location.pathname,
    search: location.search,
    createBtn: has('#createBtn'), codeIn: has('#codeIn'), joinBtn: has('#joinBtn'),
    codeBig: has('#codeBig'), errBox: has('#codeErr'),
    bodyLen: (document.body.textContent || '').trim().length,
    title: document.title,
  };
`;

/* ── 各页核查 ─────────────────────────────────────────────── */

async function checkLobby(page) {
  console.log(`\n═══ A. 模式大厅 /games/daily-challenge/lobby/ ═══`);
  page.clearEvents();
  await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/lobby/` });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'));
  await sleep(900); // 等 i18n runtime 注入文案

  const s = await page.eval(SNAP_LOBBY);
  ok(s.bodyLen > 100, `大厅有实质内容（正文 ${s.bodyLen} 字符）`);
  // 🔴 2026-10-14：原来写死 4 张 / 4 个 mode。P2 加了 emoji|chimp|word 后
  //    大厅实为 7 张，页面是对的、断言过时。改为**从大厅源码派生**期望集合 ——
  //    既能防"卡片少了"，也不会在下次加游戏时误报。
  const lobbyHtml = fs.readFileSync(
    path.join(process.cwd(), 'games/daily-challenge/lobby/index.html'), 'utf8');
  const wantModes = [...lobbyHtml.matchAll(/href="\/games\/daily-challenge\/\?mode=([a-z]+)"/g)]
    .map((m) => `?mode=${m[1]}`);
  ok(wantModes.length >= 7, `大厅源码应含 7 个mode 入口（P2 三款新游戏），实际 ${wantModes.length}`);
  ok(s.cards.length === wantModes.length,
    `大厅卡片数与源码一致（实测 ${s.cards.length}，源码 ${wantModes.length}）`);
  const want = wantModes;
  for (const w of want) {
    const c = s.cards.find((x) => x.href.includes(w));
    ok(!!c, `卡片存在 ${w}`);
    if (c) {
      ok(c.name.length > 0, `  ${w} 有可访问名（"${c.name.slice(0, 28)}"）`);
      ok(c.w >= 100 && c.h >= 40, `  ${w} 卡片可点区域 ${c.w}×${c.h}`);
    }
  }
  // 全部卡片必须指向同一个游戏页（大厅范式：纯 <a href>，不掺 JS 路由）
  const badTarget = s.cards.filter((c) => !c.href.startsWith('/games/daily-challenge/'));
  ok(badTarget.length === 0, `所有卡片都指向每日挑战页（异常 ${badTarget.length} 个）`);

  const probs = page.problems();
  ok(probs.length === 0, `大厅零 console 错误/未捕获异常${probs.length ? ' → ' + probs.slice(0, 2).join(' | ') : ''}`);
  return s;
}

async function checkLobbyClicks(page) {
  console.log(`\n═══ B. 大厅卡片真实点击 → 跳转 ═══`);
  for (const w of ['?mode=daily', '?mode=number', '?mode=sequence', '?mode=color']) {
    page.clearEvents();
    await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/lobby/` });
    await page.waitFor(() => page.eval('return document.readyState === "complete";'));
    await sleep(800);
    // 真实 DOM 点击（lobby 是纯 <a href>，点击必须触发导航）
    const clicked = await page.eval(`
      const a = [...document.querySelectorAll('a[href*="${w}"]')][0];
      if (!a) return false;
      a.click();
      return true;
    `);
    const landed = await page.waitFor(
      () => page.eval(`return location.search.includes("${w}") && location.pathname === "/games/daily-challenge/";`),
      15000,
    );
    ok(clicked && landed, `点击 ${w} 卡片 → 落到 /games/daily-challenge/${w}`);
    if (!landed) {
      info('实际 URL: ' + (await page.eval('return location.pathname + location.search;')));
    }
  }
}

async function checkDeepLink(page, mode) {
  console.log(`\n══─ C. 深链入局 ?mode=${mode} ───`);
  page.clearEvents();
  const url = `${ORIGIN}/games/daily-challenge/?mode=${mode}`;
  await page.send('Page.navigate', { url });
  await sleep(3500); // 给 fetchToday + 首关准备态渲染留时间

  const s = await page.eval(SNAP_DC);
  ok(s.search.includes(`mode=${mode}`) && !s.path.endsWith('/lobby/'),
    `?mode=${mode} 未被弹回大厅（URL=${s.path}${s.search}）`);
  // 按关卡准备态形态分别认（#go = 「我准备好了」按钮，三关都有）
  const body = s.ans || s.grid || s.row || s.go;
  ok(!!body, `?mode=${mode} 渲染出关卡准备态（ans=${s.ans} grid=${s.grid} row=${s.row} go=${s.go}）`);
  ok(s.go, `?mode=${mode} 出现「我准备好了」按钮（深链解析成功的铁证）`);
  // 准备态正文很短（header + 标题 + 一句帮助 + 按钮），阈值按 60 计
  ok(s.bodyLen > 60, `?mode=${mode} 页面有实质内容（${s.bodyLen} 字符）`);
  // 🔴 进度条必须与本局关卡数一致：单关模式只能有 1 个 step，
  //    画成三关会让玩家以为还要再玩两关（2026-10-13 实测修过的 bug）
  const wantSteps = mode === 'daily' ? 3 : 1;
  ok(s.steps === wantSteps,
    `?mode=${mode} 进度条 ${wantSteps} 关（实测 ${s.steps} → "${s.stepText}"）`);
  const probs = page.problems();
  ok(probs.length === 0, `?mode=${mode} 零 console 错误${probs.length ? ' → ' + probs.slice(0, 2).join(' | ') : ''}`);
}

async function checkBadMode(page) {
  console.log(`\n═══ D. 兜底：无效 mode / 邀请码优先 ═══`);
  // D1 无效 mode 必须回大厅，且大厅要正常渲染（不能白屏/半死）
  page.clearEvents();
  await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=bogus` });
  await sleep(2500);
  const s1 = await page.eval(SNAP_DC);
  ok(s1.path.endsWith('/lobby/'), `无效 mode=bogus 被 replace 回大厅（实际 ${s1.path}${s1.search}）`);
  ok(s1.bodyLen > 100, `回大厅后有实质内容（${s1.bodyLen} 字符，非白屏）`);
  const cards = await page.eval(`return document.querySelectorAll('a[href*="?mode="]').length;`);
  // 🔴 2026-10-14：原来写死 === 4。P2 上线 emoji/chimp/word 后大厅实为 7 张卡，
  //    页面是对的、断言过时。改成与源码 HTML 里的 data-mode 卡片数对齐 ——
  //    数量写死必被下一次加游戏打断，从源码派生才既能防"卡片少了"又不误报。
  const expectCards = (await fs.promises.readFile(
    path.join(process.cwd(), 'games/daily-challenge/lobby/index.html'), 'utf8'))
    .match(/data-mode="/g).length;
  ok(cards === expectCards,
    `大厅模式卡片数与源码一致（实测 ${cards}，源码 ${expectCards}）`);

  // D1b 回大厅后进度条不残留：大厅页本身没有 .dc-step，若出现说明串页
  const stray = await page.eval(`return document.querySelectorAll('.dc-step').length;`);
  ok(stray === 0, `大厅无残留进度条元素（实测 ${stray}）`);

  // D2 空 mode 等同 daily（不应回大厅）
  page.clearEvents();
  await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/` });
  await sleep(2500);
  const s2 = await page.eval(SNAP_DC);
  ok(!s2.path.endsWith('/lobby/'), `无 mode 参数时按每日三关入局（实际 ${s2.path}${s2.search}）`);
  ok(s2.ans || s2.grid || s2.row || s2.go, `无 mode 时渲染出关卡准备态`);
  ok(s2.steps === 3, `无 mode 时进度条为三关（实测 ${s2.steps}）`);

  // D3 邀请码优先：?c= 应被带到大厅（优先于 mode）
  page.clearEvents();
  await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=number&c=TESTCODE1` });
  await sleep(2500);
  const s3 = await page.eval(SNAP_DC);
  ok(s3.path.endsWith('/lobby/') && /c=TESTCODE1/.test(s3.search),
    `?c= 优先于 ?mode=，被带到大厅（实际 ${s3.path}${s3.search}）`);
}

/* 派生出的对战页清单必须与源码 games/ 里真正引用 duel 内核的目录一致。
   🔴 与单测p1-5 里「每个 games/<slug>/index.html 都注册进 vite input」互为犄角：
      那条防「页面存在但没构建」，这条防「页面存在但没验收」。 */
function assertDuelCoverage(dirs) {
  ok(dirs.length >= 6, `对战页覆盖数 ${dirs.length}（含 P2 三款新游戏则应为 6）`);
  for (const g of ['emoji-ghost', 'chimp-test', 'word-recall']) {
    ok(dirs.includes(g), `P2 新游戏 ${g} 的对战页必须纳入巡检（否则新增游戏零覆盖）`);
  }
}

async function checkDuelPage(page, slug, label) {
  console.log(`\n═══ E. 对战页 ${label} ${slug} ═══`);
  page.clearEvents();
  await page.send('Page.navigate', { url: `${ORIGIN}${slug}` });
  await page.waitFor(() => page.eval('return document.readyState === "complete";'));
  await sleep(1200); // 等 session 建立 + 入口渲染

  const s = await page.eval(SNAP_DUEL);
  ok(s.createBtn, `${label} 出现「创建对决」按钮`);
  ok(s.codeIn, `${label} 出现房码输入框`);
  ok(s.joinBtn, `${label} 出现「加入」按钮`);
  ok(s.bodyLen > 80, `${label} 页面有实质内容（${s.bodyLen} 字符）`);
  ok(/duel|Duel|对决|Recall|Memory/i.test(s.title), `${label} title 合理（"${s.title}"）`);
  const probs = page.problems();
  ok(probs.length === 0, `${label} 零 console 错误${probs.length ? ' → ' + probs.slice(0, 2).join(' | ') : ''}`);
}

async function checkGoButton(page) {
  console.log(`\n═══ G. 点击「我准备好了」→ 进入预览（三关逐一实测）═══`);
  // 🔴 2026-10-13 实测：playColor 漏了 go.disabled / go.style.display='none'
  //    （另两关都有），导致 4.2s 预览期间按钮仍可点却不再响应。
  //    这里逐关点一次，用「预览元素出现 + 按钮已隐藏」两个外部事实锁定。
  const cases = [
    { mode: 'color', previewSel: '#row > *', previewCount: 5, label: '颜色还原' },
    { mode: 'sequence', previewSel: '#grid', previewCount: 0, label: '序列记忆' },
    { mode: 'number', previewSel: '#stage', previewCount: 0, label: '数字广度' },
  ];
  for (const cse of cases) {
    page.clearEvents();
    await page.send('Page.navigate', { url: `${ORIGIN}/games/daily-challenge/?mode=${cse.mode}` });
    const appeared = await page.waitFor(
      () => page.eval('return !!document.querySelector("#go");'), 20000,
    );
    if (!appeared) { ok(false, `${cse.label} 准备态按钮未出现`); continue; }
    await sleep(600);
    const before = await page.eval(`
      const go = document.querySelector('#go');
      return { rowKids: document.querySelectorAll('#row > *').length,
               goShown: go ? getComputedStyle(go).display !== 'none' : false };
    `);
    // 真实 DOM 点击（与线上用户点击同一路径）
    await page.eval(`document.querySelector('#go').click();`);
    await sleep(900);
    const after = await page.eval(`
      const go = document.querySelector('#go');
      return { rowKids: document.querySelectorAll('#row > *').length,
               goHidden: go ? (go.disabled && getComputedStyle(go).display === 'none') : true,
               wheel: !!document.querySelector('#wheel') };
    `);
    if (cse.mode === 'color') {
      // color 点击后先展示 5 个目标色（4.2s），此时色轮还没出现
      ok(after.rowKids === cse.previewCount,
        `${cse.label} 点击后展示 ${cse.previewCount} 个目标色（实测 ${after.rowKids}）`);
    }
    ok(after.goHidden,
      `${cse.label} 点击后「我准备好了」被停用并隐藏（goHidden=${after.goHidden}）`);
    const probs = page.problems();
    ok(probs.length === 0, `${cse.label} 点击后零 console 错误${probs.length ? ' → ' + probs[0] : ''}`);
  }
}

async function checkLangConsistency(page, slug, label) {
  console.log(`\n═══ F. i18n 一致性 ${label} ═══`);
  for (const lang of ['zh', 'en']) {
    page.clearEvents();
    await page.send('Page.navigate', { url: `${ORIGIN}${slug}?lang=${lang}` });
    await page.waitFor(() => page.eval('return document.readyState === "complete";'));
    await sleep(900);
    const r = await page.eval(`
      return {
        htmlLang: document.documentElement.lang,
        dict: window.__i18nLang || window.__lang || null,
        bodySample: (document.body.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 60),
      };
    `);
    ok(r.htmlLang === lang, `${label} [${lang}] <html lang> 一致（实测 ${r.htmlLang}）`);
    info(`[${lang}] 首屏文案："${r.bodySample}"`);
  }
}

/* ── 主流程 ───────────────────────────────────────────────── */

async function main() {
  const port = 9755;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-pages-'));
  const proc = spawn(EXE, [
    '--headless=new', `--remote-debugging-port=${port}`, '--disable-gpu',
    '--no-first-run', '--hide-scrollbars', `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    const page = await CDP.attach(port);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');

    await checkLobby(page);
    await checkLobbyClicks(page);
    await checkDeepLink(page, 'daily', 'number-recall');
    await checkDeepLink(page, 'number', 'number-recall');
    await checkDeepLink(page, 'sequence', 'sequence-memory');
    await checkDeepLink(page, 'color', 'color-recall');
    // 🔴 2026-10-14：P2 三款新游戏原先零深链覆盖（深链解析失败会静默弹回大厅，
    //    正好是最容易漏的一类）。补齐，单关模式要出现且不被弹回。
    await checkDeepLink(page, 'emoji', 'emoji-ghost');
    await checkDeepLink(page, 'chimp', 'chimp-test');
    await checkDeepLink(page, 'word', 'word-recall');
    await checkBadMode(page);
    await checkGoButton(page);

    // 🔴 2026-10-14：原来逐条写死三款 → P2 上线 emoji/chimp/word 后这三条对战页
    //    处于**零覆盖**状态（页面 404、脚本都不会红）。改为遍历 games/ 目录派生，
    //    下次加游戏自动纳入，不用记得回来改脚本。
    const DUEL_LABEL = {
      'sequence-memory': '序列对战', 'number-recall': '数字对战', 'color-recall': '颜色对战',
      'emoji-ghost': '表情幽灵对战', 'chimp-test': '猩猩测试对战', 'word-recall': '词语记忆对战',
    };
    const duelDirs = fs.readdirSync(path.join(process.cwd(), 'games'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(process.cwd(), 'games', d.name, 'index.html')))
      // 🔴 只认**引用对战内核**的目录：daily-challenge 也有 games/<slug>/index.html，
      //    但它走 daily-game.ts（每日挑战），没有建房/房码/加入入口，
      //    按目录无差别纳入会凭空多出 3 条必然失败的断言（2026-10-14 实测踩到）。
      //    判据用源码事实（引 duel-sequence.ts），不靠 slug 白名单。
      .filter((d) => fs.readFileSync(
        path.join(process.cwd(), 'games', d.name, 'index.html'), 'utf8')
        .includes('/src/pages/duel-sequence.ts'))
      .map((d) => d.name);
    assertDuelCoverage(duelDirs);
    for (const g of duelDirs) {
      await checkDuelPage(page, `/games/${g}/`, DUEL_LABEL[g] || g);
    }

    await checkLangConsistency(page, '/games/daily-challenge/lobby/', '大厅');
    await checkLangConsistency(page, '/games/color-recall/', '颜色对战');

    console.log(`\n${'═'.repeat(56)}`);
    console.log(`  合计：${pass} 通过 / ${fail} 失败`);
    console.log('═'.repeat(56));
    if (fail > 0) process.exitCode = 1;
  } finally {
    proc.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((e) => { console.error('核查脚本异常：', e); process.exitCode = 1; });
