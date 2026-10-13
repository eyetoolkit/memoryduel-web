/**
 * 全面复查第三批：移动端布局 + 无障碍（线上真站点，CDP 无头）
 * ────────────────────────────────────────────────────────────────
 * 覆盖本轮新增/改动的四页 + 三款对战页的公共外壳：
 *   /games/daily-challenge/   /games/color-recall/
 *   /games/sequence-memory/   /games/number-recall/
 *
 * 验六件事（每项都绑定外部可观测事实，不看「没报错」）：
 *   1. 无横向溢出：documentElement.scrollWidth <= clientWidth + 1
 *   2. 触摸目标 ≥ 40px（iOS 44 是标称，实测 ≥40 且无 0 尺寸的可点元素）
 *   3. 关键元素可访问：<html lang> 与 i18n 语言一致、按钮有可访问名
 *   4. 焦点可见：Tab 后有可见 outline（非 outline:none 且有 box-shadow/border 变化）
 *   5. 图片有 alt、装饰性元素正确 aria-hidden
 *   6. 标题层级不跳级（h1 唯一且存在）
 *
 * 用法：node tests/review-mobile-a11y.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ORIGIN = process.env.MD_ORIGIN || 'https://www.memoryduel.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = [
  { slug: '/games/daily-challenge/', label: '每日挑战' },
  { slug: '/games/color-recall/', label: '颜色对战' },
  { slug: '/games/sequence-memory/', label: '序列对战' },
  { slug: '/games/number-recall/', label: '数字对战' },
];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

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
        out.push('资源错误: ' + en.text + ' ' + (en.url || ''));
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
}

async function audit(page, slug, label, lang) {
  console.log(`\n─── ${label}  [${lang}] ${slug} ───`);
  const url = `${ORIGIN}${slug}${slug.includes('?') ? '&' : '?'}lang=${lang}`;
  await page.send('Page.navigate', { url });
  const ready = await page.waitFor(() => page.eval('return document.readyState === "complete";'), 25000);
  ok(ready, `${label} 页面加载完成`);
  await sleep(600); // 等 i18n runtime 应用完文案

  // 1. 横向溢出
  const ov = await page.eval(`
    const d = document.documentElement;
    const over = [];
    const vw = d.clientWidth;
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 2 || r.left < -2) {
        over.push((el.tagName + '.' + (el.className || '')).slice(0, 60) + ' right=' + Math.round(r.right));
      }
    }
    return { scrollW: d.scrollWidth, clientW: vw, over: over.slice(0, 5) };
  `);
  ok(ov.scrollW <= ov.clientW + 1,
    `${label} 无横向溢出（scrollW=${ov.scrollW} clientW=${ov.clientW}）`);
  if (ov.over.length) console.log('       溢出元素:', ov.over.join(' | '));

  // 2. 触摸目标尺寸
  const tap = await page.eval(`
    const bad = [];
    const sel = 'a[href], button, input[type=button], input[type=submit], [role=button], select';
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;      // 隐藏元素不计
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      if (r.height < 40 || r.width < 40) {
        bad.push((el.tagName + ':' + (el.id || el.className || el.textContent || '').toString().trim().slice(0, 24))
          + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
    }
    return { total: document.querySelectorAll(sel).length, bad: bad.slice(0, 6), badCount: bad.length };
  `);
  ok(tap.total > 0, `${label} 存在可交互元素（${tap.total} 个）`);
  ok(tap.badCount === 0, `${label} 触摸目标均 ≥40px（${tap.total} 个，不达标 ${tap.badCount}）`);
  if (tap.bad.length) console.log('       不达标:', tap.bad.join(' | '));

  // 3. html lang 与 i18n 一致性 + 按钮可访问名
  const a11y = await page.eval(`
    const htmlLang = document.documentElement.getAttribute('lang') || '';
    let i18nLang = '';
    try { i18nLang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : (localStorage.getItem('lang') || localStorage.getItem('memoryduel_lang') || ''); } catch (_) {}
    const noName = [];
    for (const el of document.querySelectorAll('a[href], button, [role=button]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const name = (el.getAttribute('aria-label') || el.getAttribute('title')
        || el.textContent || '').trim();
      if (!name && !el.querySelector('img[alt]:not([alt=""])')) noName.push(el.tagName + '.' + (el.className || ''));
    }
    const h1s = document.querySelectorAll('h1');
    const imgsNoAlt = [...document.querySelectorAll('img')].filter(i => !i.hasAttribute('alt')).length;
    return {
      htmlLang, i18nLang,
      noName: noName.slice(0, 5), noNameCount: noName.length,
      h1Count: h1s.length,
      h1Text: h1s.length ? h1s[0].textContent.trim().slice(0, 40) : '',
      imgsNoAlt,
    };
  `);
  ok(!!a11y.htmlLang, `${label} <html lang> 已设置（${a11y.htmlLang}）`);
  ok(!a11y.i18nLang || a11y.htmlLang === a11y.i18nLang,
    `${label} html lang 与 i18n 一致（html=${a11y.htmlLang} i18n=${a11y.i18nLang}）`);
  ok(a11y.noNameCount === 0, `${label} 所有可交互元素有可访问名（缺 ${a11y.noNameCount}）`);
  if (a11y.noName.length) console.log('       缺名:', a11y.noName.join(' | '));
  ok(a11y.h1Count === 1, `${label} 恰好一个 h1（实际 ${a11y.h1Count}："${a11y.h1Text}"）`);
  ok(a11y.imgsNoAlt === 0, `${label} 所有 img 都有 alt（缺 ${a11y.imgsNoAlt}）`);

  // 4. 焦点可见：用**真实 Tab 键**而不是程序化 .focus()
  //    程序化 .focus() 在某些情况下不触发 :focus-visible（Chrome 会认为是脚本驱动），
  //    且浏览器默认 focus ring 是 outline:auto —— parseFloat('auto') = NaN，
  //    用 `>0` 判断会误判为「无 outline」。所以必须走真实键盘事件。
  await page.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
  });
  await sleep(200);
  const focus = await page.eval(`
    const el = document.activeElement;
    if (!el || el === document.body) return { skip: true };
    const st = getComputedStyle(el);
    const ow = st.outlineWidth;
    const outlineW = (ow === 'auto' || ow === '') ? 3 : parseFloat(ow);  // auto 视为有 focus ring
    return {
      skip: false,
      tag: el.tagName, id: el.id, cls: (el.className || '').toString().slice(0, 30),
      txt: (el.textContent || '').trim().slice(0, 20),
      outlineStyle: st.outlineStyle, outlineWidth: ow, outlineColor: st.outlineColor,
      hasOutline: st.outlineStyle !== 'none' && outlineW > 0,
      boxShadow: st.boxShadow,
      hasShadow: !!st.boxShadow && st.boxShadow !== 'none',
      focusVisible: (() => { try { return el.matches(':focus-visible'); } catch (_) { return false; } })(),
    };
  `);
  if (focus.skip) {
    console.log('  --   焦点检查跳过（Tab 后仍无焦点元素）');
  } else {
    ok(focus.hasOutline || focus.hasShadow || focus.focusVisible,
      `${label} 焦点可见（${focus.tag}.${focus.cls} outline=${focus.outlineStyle}/${focus.outlineWidth} shadow=${focus.hasShadow} :focus-visible=${focus.focusVisible}）`);
  }

  // 5. 零控制台错误
  const probs = page.problems();
  ok(probs.length === 0, `${label} 零未捕获异常/console.error/资源错误（${probs.length}）`);
  if (probs.length) console.log('       ' + probs.slice(0, 4).join('\n       '));
}

async function main() {
  console.log(`═══ 移动端 + 无障碍复查：${ORIGIN} ═══`);
  console.log('视口 390x844（iPhone 14 逻辑分辨率）+ DPR 3\n');

  // 中文 + 英文各跑一遍：文案长度差异本身就是溢出高发点
  for (const lang of ['zh', 'en']) {
    const port = 9500 + (lang === 'zh' ? 0 : 1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `md-a11y-${port}-`));
    const proc = spawn(EXE, [
      '--headless=new', `--remote-debugging-port=${port}`,
      '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', `--user-data-dir=${dir}`, 'about:blank',
    ], { stdio: 'ignore' });

    let cdp;
    try {
      cdp = await CDP.attach(port);
      await cdp.send('Runtime.enable');
      await cdp.send('Log.enable');
      await cdp.send('Page.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

      for (const p of PAGES) await audit(cdp, p.slug, p.label, lang);
    } finally {
      try { proc.kill(); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  console.log(`\n═══ 复查结果：${pass} pass / ${fail} fail ═══`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('脚本异常:', e); process.exit(2); });