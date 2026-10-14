/**
 * 设计量化探针（2026-10-14）
 * ────────────────────────────────────────────────────────────
 * 为什么要有这个：设计评审最容易变成"我觉得这里有点挤"。
 * 主观判断不可复现、不可回归、下次没人说得清。
 * 能量的就别靠眼睛 —— 对比度、字号阶、间距节奏、点击区域、
 * 层级对比都是确定性数值，量出来就能断言、能回归。
 *
 * 覆盖六条可量化的设计判据：
 *   1. 文本对比度 WCAG AA（正文 4.5:1 / 大字 3:1）
 *   2. 字号阶梯是否成体系（不该出现 13px / 17px 这类孤立值）
 *   3. 间距节奏（同一层级的块间距是否一致，抖动是否 > 2x）
 *   4. 触摸目标 ≥ 44px（Apple HIG / WCAG 2.5.5）
 *   5. 视觉层级对比（标题与正文的字号差、字重差）
 *   6. 暗色模式下的对比度是否同样达标（很多站只在亮色达标）
 *
 * 用法：node tests/audit-design-tokens.mjs [--lang en] [--pages a,b]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ORIGIN = process.env.MD_ORIGIN || 'https://www.memoryduel.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d; };
const LANG = arg('--lang', 'en');

const PAGES = (arg('--pages', 'daily,lobby,duel') || '').split(',').map((s) => {
  const map = {
    home: '/', lobby: '/games/daily-challenge/lobby/',
    daily: '/games/daily-challenge/', duel: '/games/sequence-memory/',
  };
  return map[s.trim()] || s.trim();
});

let pass = 0, fail = 0, warn = 0;
const findings = [];
const ok = (c, m, level = 'fail') => {
  if (c) { pass++; return; }
  if (level === 'warn') { warn++; findings.push('⚠ ' + m); console.log(`  WARN ${m}`); }
  else { fail++; findings.push('✗ ' + m); console.log(`  FAIL ${m}`); }
};
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    return r.result.value;
  }
  async waitFor(fn, timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { if (await fn()) return true; } catch (_) {} await sleep(200); }
    return false;
  }
}

/* 注入到页面的量测脚本：srgb → 相对亮度 → 对比度 */
const MEASURE = `
  const px = (v) => parseFloat(v) || 0;
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const parse = (s) => {
    const m = String(s).match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg, a) => fg.map((c, i) => c * a + bg[i] * (1 - a));
  /* 🔴 2026-10-14 修正（两处，都是判据自身的 bug，不是产品问题）：
     ① 原来只认alpha>0.95 的不透明背景，遇到 rgba(250,246,241,.86) 这类
        半透明层就一直往上找，找不到就fallback 白色 → 算出假失败。
     ② 合成时必须按**各自的 alpha** 逐层叠加：
        stack = [自, 父, 祖...]，从最不透明的一层往上叠，
        每一层用**它自己的 a** 与已合成的下层混合。
        原来写成 over(rgb, out) 等价于 a=1，把半透明层当不透明 → 又算错。
     本页header 就是 rgba(250,246,241,.86) 叠在暖纸底上，
     不修正会得到 0:1 / null:1 的「对比度灾难」假象。 */
  const bgOf = (el) => {
    const stack = [];
    let e = el;
    while (e) {
      const b = parse(getComputedStyle(e).backgroundColor);
      if (b && b.a > 0) { stack.push(b); if (b.a >= 0.999) break; }
      e = e.parentElement;
    }
    if (!stack.length) return [255, 255, 255];
    let out = stack[stack.length - 1].rgb;
    for (let i = stack.length - 2; i >= 0; i--) out = over(stack[i].rgb, out, stack[i].a);
    return out;
  };
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
  };

  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || px(cs.opacity) < 0.15) return false;
    if (el.closest('[hidden],[aria-hidden="true"]')) return false;
    return true;
  };
  const label = (el) => (el.innerText || el.getAttribute('aria-label') || el.className || el.tagName)
    .replace(/\\s+/g, ' ').trim().slice(0, 30);

  /* 可见文本节点：取直接含文字的元素 */
  const texts = [...document.querySelectorAll('body *')].filter((el) => {
    if (el.children.length && ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return false;
    return el.textContent.trim().length > 0 && vis(el);
  });

  const samples = texts.slice(0, 400).map((el) => {
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    const bg = bgOf(el);
    if (!fg) {
      /*🔴 量测失败的样本必须**标出来**而不是喂给 ratio()：
         parse 失败 → eff 为 null → lum(null) 抛错或算出 null:1，
         报出来的是「对比度 0:1」，看着像产品色灾难，实际是判据自己的 bug。
         上一轮就因为这个差点去改产品的色值。 */
      return { label: label(el), size: px(cs.fontSize), weight: Number(cs.fontWeight) || 400,
        ratio: null, unmeasurable: 'color=' + cs.color, large: false,
        cls: (typeof el.className === 'string' ? el.className : '').split(' ')[0],
        tag: el.tagName.toLowerCase() };
    }
    const eff = fg.a < 1 ? over(fg.rgb, bg, fg.a) : fg.rgb;
    const size = px(cs.fontSize);
    const w = Number(cs.fontWeight) || 400;
    return {
      label: label(el), size, weight: w,
      ratio: ratio(eff, bg),
      large: size >= 24 || (size >= 18.66 && w >= 700),
      cls: (typeof el.className === 'string' ? el.className : '').split(' ')[0],
      tag: el.tagName.toLowerCase(),
    };
  });
  const measurable = samples.filter((s) => typeof s.ratio === 'number');

  /* 触摸目标 */
  const taps = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"]')]
    .filter(vis)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { label: label(el), w: Math.round(r.width), h: Math.round(r.height) };
    })
    .filter((t) => t.h < 44 || t.w < 44);

  /* 字号阶梯 */
  const sizes = [...new Set(samples.map((s) => s.size))].sort((a, b) => a - b);

  /* 同级块间距抖动：取同级可见块的 gap 分布 */
  const gaps = [];
  for (const el of [...document.querySelectorAll('body *')].slice(0, 200)) {
    if (!vis(el)) continue;
    const kids = [...el.children].filter(vis);
    if (kids.length < 3) continue;
    const cs = getComputedStyle(el);
    if (cs.display.includes('flex') || cs.display.includes('grid')) {
      const g = px(cs.rowGap) || px(cs.gap);
      if (g > 0) gaps.push({ parent: label(el).slice(0, 18), gap: Math.round(g), n: kids.length });
    }
  }

  return {
    samples, measurable, taps, sizes, gaps,
    title: document.title,
    theme: document.documentElement.getAttribute('data-theme')
      || (document.documentElement.className.match(/dark|night/i) || [''])[0],
  };
`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mddsg-'));
  const port = 9700 + Math.floor(Math.random() * 250);
  const proc = spawn(EXE, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const page = await CDP.attach(port);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    for (const p of PAGES) {
      const label = p === '/' ? '首页' : p.replace('/games/', '').replace(/\/$/, '');
      console.log(`\n${'─'.repeat(56)}\n页面 ${label}  ${p}?lang=${LANG}`);
      await page.send('Page.navigate', { url: `${ORIGIN}${p}?lang=${LANG}` });
      await page.waitFor(() => page.eval('return document.readyState === "complete";'));
      await sleep(1200);

      /* ── 1. 对比度 ── */
      section(`1. 文本对比度 AA — ${label}`);
      const d = await page.eval(MEASURE);
      const un = d.samples.filter((s) => s.unmeasurable);
      ok(un.length === 0,
        `${label} 无量测失败样本（${un.length} 处）` +
        (un.length ? '：' + un.slice(0, 5).map((s) => `"${s.label}" ${s.unmeasurable}`).join('; ') : ''));
      const base = d.measurable;
      const failC = base.filter((s) => s.ratio < (s.large ? 3 : 4.5));
      const warnC = base.filter((s) => s.ratio >= (s.large ? 3 : 4.5) && s.ratio < (s.large ? 4.5 : 7));
      ok(failC.length === 0,
        `${label} 无低于 AA 的文本（${failC.length} 处）` +
        (failC.length ? '：' + failC.slice(0, 6).map((s) => `"${s.label}" ${s.size}px ${s.ratio}:1`).join('; ') : ''));
      const lo = base.length ? Math.min(...base.map((s) => s.ratio)) : 0;
      console.log(`  达标 ${base.length - failC.length}/${base.length}，` +
        `仅达 AA 未达 AAA ${warnC.length}，最低 ${lo}:1`);

      /* ── 1b. 暗色主题对比度 ──
         🔴 2026-10-15 补：本脚本头注释宣称覆盖「暗色模式对比度」，
            但实际上**从未切换过主题**（只在末尾读一下 data-theme 属性），
            也就是暗色下有问题的文本一条都没量过。首页暗色 .tab.on
            「白底 + 亮橙字 2.80:1」就是这样漏网的 —— 亮色全绿、暗色全瞎。
            判据同样走 AA（大字 3:1 / 正文 4.5:1）。 */
      /* 🔴 只对**真正支持暗色**的页面跑暗色扫描。
         判定：页面加载了 /shared/theme.js，或内联脚本里出现 data-theme。
         反例：games/sequence-memory/index.html 引了 home.css（含
         html[data-theme=dark] 块）却**没引 theme.js** —— 用户永远到不了暗色，
         强切 data-theme 只会把「页面本来就不支持的主题」量成一堆假失败。 */
      /* 🔴 必须写成 `return (...)()`：page.eval 会把表达式包进
         `(async () => { <expr> })()`，外层没有 return，
         IIFE 的返回值会被直接丢弃 → supportsDark 恒为 undefined（假跳过）。 */
      const supportsDark = await page.eval(`return (() => {
        const s = [...document.querySelectorAll('script')];
        return s.some(x => /theme\\.js/.test(x.src || ''))
            || s.some(x => /data-theme/.test(x.textContent || ''));
      })();`);
      if (!supportsDark) {
        console.log(`  ⚠ ${label} 不支持暗色（无 theme.js / 无内联主题脚本），跳过暗色扫描`);
      } else {
      await page.eval(`document.documentElement.setAttribute('data-theme','dark'); return 1;`);
      await sleep(600);
      const dk = await page.eval(MEASURE);
      const dkBase = dk.measurable;
      const dkFail = dkBase.filter((s) => s.ratio < (s.large ? 3 : 4.5));
      ok(dkFail.length === 0,
        `${label} 暗色主题无低于 AA 的文本（${dkFail.length} 处）` +
        (dkFail.length ? '：' + dkFail.slice(0, 6)
          .map((s) => `"${s.label}" <${s.tag}.${s.cls}> ${s.size}px/${s.weight} ${s.ratio}:1`)
          .join('; ') : ''));
      if (dkBase.length) {
        console.log(`  暗色达标 ${dkBase.length - dkFail.length}/${dkBase.length}，` +
          `最低 ${Math.min(...dkBase.map((s) => s.ratio))}:1`);
      }
      await page.eval(`document.documentElement.setAttribute('data-theme','light'); return 1;`);
      await sleep(400);
      }

      /* ── 2. 字号阶梯 ── */
      section(`2. 字号阶梯 — ${label}`);
      console.log(`  实测字号集：${d.sizes.join(', ')}`);
      // 孤立的非 2/4 倍数值：设计系统常用 12/14/16/18/20/24/28/32/40
      const odd = d.sizes.filter((s) => ![12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48].includes(Math.round(s)));
      ok(odd.length === 0, `${label} 字号都在阶梯内（偏离 ${odd.length} 个：${odd.join(', ')}）`, 'warn');

      /* ── 3. 触摸目标 ── */
      section(`3. 触摸目标 ≥44px — ${label}`);
      const badTap = d.taps;
      ok(badTap.length === 0,
        `${label} 全部可交互元素达标（${badTap.length} 处偏小）` +
        (badTap.length ? '：' + badTap.slice(0, 6).map((t) => `"${t.label}" ${t.w}×${t.h}`).join('; ') : ''),
        'warn');

      /* ── 4. 间距节奏 ── */
      section(`4. 同级块间距抖动 — ${label}`);
      const gs = d.gaps.map((g) => g.gap);
      if (gs.length >= 3) {
        const mn = Math.min(...gs), mx = Math.max(...gs);
        ok(mx / mn <= 2.2,
          `${label} 同级间距在 2.2x 内（实测 ${mn}~${mx}px，共 ${gs.length} 组）`, 'warn');
      } else {
        console.log(`  样本不足（${gs.length} 组），跳过`);
      }

      /* ── 5. 视觉层级 ── */
      section(`5. 标题与正文层级差 — ${label}`);
      const h1 = d.samples.filter((s) => ['h1', 'h2'].includes(s.tag));
      const body = d.samples.filter((s) => ['p', 'span', 'div', 'li'].includes(s.tag));
      if (h1.length && body.length) {
        const hMax = Math.max(...h1.map((s) => s.size));
        const bMin = Math.min(...body.map((s) => s.size));
        console.log(`  标题最大 ${hMax}px，正文最小 ${bMin}px，比值 ${(hMax / bMin).toFixed(2)}x`);
        ok(hMax / bMin >= 1.4, `${label} 标题与正文层级差 ≥1.4x`, 'warn');
      }
    }

    console.log(`\n${'═'.repeat(56)}`);
    console.log(`  ${pass} 通过 / ${fail} 失败 / ${warn} 警告`);
    if (fail) process.exitCode = 1;
    console.log('═'.repeat(56));
  } finally {
    proc.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
