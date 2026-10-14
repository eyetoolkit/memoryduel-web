/**
 * 页面设计评审取图工具（2026-10-14）
 * ────────────────────────────────────────────────────────────
 * 目的：设计评审必须看**真实渲染**，不能凭源码猜。本脚本按
 *「页面 × 视口 × 语言」批量出图，供人工/多模态评审。
 *
 * 为什么不复用 review-pages-check 的CDP 类：那个类生命周期绑在
 * main() 的 finally 里，且 evaluate 包装固定。本工具要独立多次
 * 导航 + 视口切换 + 落盘，故自持一份（CDP 协议就这60 行，
 * 重复优于耦合——抽取公共模块的成本高于收益）。
 *
 * 用法：
 *   node tests/shoot-design-review.mjs                     # 默认套组
 *   node tests/shoot-design-review.mjs --lang ja           # 换语言
 *   node tests/shoot-design-review.mjs --only duel         # 只拍对战页
 *   node tests/shoot-design-review.mjs --full             # 桌面+移动+暗色全量
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ORIGIN = process.env.MD_ORIGIN || 'https://www.memoryduel.com';
const OUT = process.env.MD_SHOT_DIR
  || path.join(process.cwd(), '_design-review', new Date().toISOString().slice(0, 10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i > -1 ? argv[i + 1] : d;
};
const LANG = arg('--lang', 'zh');
const ONLY = arg('--only', '');
const FULL = argv.includes('--full');

/* 视口：DPR3 = 真实手机；桌面 1440 宽是当前主流笔记本 */
const VIEWPORTS = FULL ? [
  { name: 'desktop', width: 1440, height: 900, dpr: 1, mobile: false },
  { name: 'mobile', width: 390, height: 844, dpr: 3, mobile: true },
] : [{ name: 'mobile', width: 390, height: 844, dpr: 3, mobile: true }];

/* 页面清单：覆盖首页 / 大厅 / 每日挑战 / 六款对战 / 教师端 / 静态页 */
const PAGES = [
  { slug: 'home', path: '/', label: '首页' },
  { slug: 'lobby', path: '/games/daily-challenge/lobby/', label: '挑战大厅' },
  { slug: 'daily', path: '/games/daily-challenge/', label: '每日挑战' },
  { slug: 'duel-sequence', path: '/games/sequence-memory/', label: '序列对战' },
  { slug: 'duel-number', path: '/games/number-recall/', label: '数字对战' },
  { slug: 'duel-color', path: '/games/color-recall/', label: '颜色对战' },
  { slug: 'duel-emoji', path: '/games/emoji-ghost/', label: '表情幽灵对战' },
  { slug: 'duel-chimp', path: '/games/chimp-test/', label: '猩猩测试对战' },
  { slug: 'duel-word', path: '/games/word-recall/', label: '词语记忆对战' },
  { slug: 'battle', path: '/battle', label: '教师对战页' },
  // 🔴 2026-10-14：原先写 /how-to-play/ —— 那个 URL 线上不存在（404 兜底页），
  //    拍出来的是 404 页，"横向溢出" 全来自 404 页与页头，差点误判成内容页缺陷。
  //    真实玩法页在 sitemap 里是 /how-to-play/memory-match/。
  //    → 清单里的每条路径都应先 curl 核 200，别照着目录名想当然。
  { slug: 'how-to-play', path: '/how-to-play/memory-match/', label: '玩法说明' },
  { slug: 'about', path: '/about/', label: '关于' },
  { slug: 'membership', path: '/membership/', label: '会员页' },
  { slug: 'blog', path: '/blog/memory-training-games/', label: '博客文章' },
];

const wanted = ONLY ? PAGES.filter((p) => p.slug.includes(ONLY) || p.path.includes(ONLY)) : PAGES;

/* 🔴 拍前必须核路径真实存在。
   拍到 404 兜底页是最容易发生的自我欺骗：它有完整页头、有正文长度、
   看起来"像那么回事"，于是「横向溢出」「小目标」全被归因到内容页，
   而真页面根本没被拍过。清单里写错一个路径，整轮评审的结论就偏了。
   判据：HTTP 200 且 title 不含 404。 */
async function preflight(pages) {
  console.log('── 路径预检 ──');
  const bad = [];
  for (const p of pages) {
    let code = 0, title = '';
    try {
      const r = await fetch(`${ORIGIN}${p.path}`, { redirect: 'follow' });
      code = r.status;
      title = (await r.text()).match(/<title>([^<]*)/i)?.[1] || '';
    } catch (e) { title = 'ERR:' + e.message; }
    const dead = code !== 200 || /404|not found|页面未找到/i.test(title);
    if (dead) bad.push({ ...p, code, title });
    console.log(`  ${dead ? '✗' : '✓'} ${p.path.padEnd(34)} ${code} ${dead ? '← 清单路径有误，本轮不拍' : title.slice(0, 40)}`);
  }
  if (bad.length) {
    console.log(`\n🔴 ${bad.length} 条路径不存在：${bad.map((b) => b.path).join(', ')}`);
    console.log('   拍 404 兜底页等于没拍真页面 —— 已剔除，请先修清单或用 --only 限定。');
  }
  return pages.filter((p) => !bad.some((b) => b.slug === p.slug));
}

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
    return r.result.value;
  }
  async waitFor(fn, timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await fn()) return true; } catch (_) {}
      await sleep(200);
    }
    return false;
  }
  async settle() {
    /* 等 i18n runtime 注完文案 + 字体 + 图片解码。
       🔴 关键：i18n 是客户端注入的，readyState=complete 时文案还是 key 原文，
          图出来会是「duel.col_title」这种东西 —— 比不拍还误导。 */
    await this.waitFor(() => this.eval(
      'return document.fonts ? document.fonts.status === "loaded" : true;'));
    await this.waitFor(() => this.eval(
      'return [...document.images].every((i) => i.complete);'));
    await this.eval('return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));');
    await sleep(700);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdshot-'));
  const port = 9300 + Math.floor(Math.random() * 400);
  const proc = spawn(EXE, [
    '--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    'about:blank',
  ], { stdio: 'ignore' });

  const report = [];
  try {
    const todo = await preflight(wanted);
    const page = await CDP.attach(port);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');

    for (const vp of VIEWPORTS) {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height,
        deviceScaleFactor: vp.dpr, mobile: vp.mobile,
      });
      for (const p of todo) {
        page.events.length = 0;
        const url = `${ORIGIN}${p.path}${p.path.includes('?') ? '&' : '?'}lang=${LANG}`;
        await page.send('Page.navigate', { url });
        await page.waitFor(() => page.eval('return document.readyState === "complete";'), 25000);
        await page.settle();

        const probe = await page.eval(`
          const de = document.documentElement;
          const over = [...document.querySelectorAll('body *')]
            .filter((e) => e.getBoundingClientRect().right > de.clientWidth + 2)
            .slice(0, 5).map((e) => e.tagName.toLowerCase()
              + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''));
          return {
            title: document.title,
            lang: de.lang,
            scrollW: de.scrollWidth, clientW: de.clientWidth,
            overflowX: de.scrollWidth > de.clientWidth + 1,
            overflowers: over,
            bodyLen: document.body.innerText.trim().length,
            h1: document.querySelectorAll('h1').length,
            rawKeys: (document.body.innerText.match(/\\b[a-z]{2,6}_[a-z0-9_]{3,}\\b/g) || []).slice(0, 5),
            smallTargets: [...document.querySelectorAll('a,button')]
              .map((e) => ({ e, r: e.getBoundingClientRect() }))
              .filter((x) => x.r.width > 0 && x.r.height > 0 && x.r.height < 44)
              .slice(0, 6)
              .map((x) => (x.e.innerText || x.e.getAttribute('aria-label') || x.e.className || x.e.tagName).slice(0, 24)
                 + ' h=' + Math.round(x.r.height)),
          };
        `);

        const file = path.join(OUT, `${p.slug}--${vp.name}--${LANG}.png`);
        const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

        report.push({ ...p, viewport: vp.name, file: path.basename(file), ...probe });
        const flags = [];
        if (probe.overflowX) flags.push(`横向溢出 ${probe.scrollW}>${probe.clientW}`);
        if (probe.rawKeys.length) flags.push('i18n 未注入:' + probe.rawKeys.join(','));
        if (probe.h1 !== 1) flags.push(`h1=${probe.h1}`);
        console.log(`${flags.length ? '⚠ ' : '✓ '}${p.label.padEnd(12)} ${vp.name.padEnd(8)} ${flags.join(' | ') || 'ok'}`);
      }
    }

    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`\n出图目录：${OUT}`);
    console.log(`共 ${report.length} 张，probe 见report.json`);
    const bad = report.filter((r) => r.overflowX || r.rawKeys.length || r.h1 !== 1);
    console.log(bad.length ? `需关注 ${bad.length} 项：${bad.map((b) => b.label).join(', ')}` : '全部无告警');
  } finally {
    proc.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
