/**
 * P1-12 「战书」卡片 · 真实浏览器验收（L3，跑线上）
 * ────────────────────────────────────────────────────────────────
 * 静态测试只能证明「源码里有这些字符」，证明不了：
 *   · 卡片真的会显示（[hidden] 被 display:flex 盖掉是这类 UI 的经典翻车点）
 *   · 房码排版真的等宽对齐（tabular-nums 生效没有，只能看）
 *   · 复制真的能复制到剪贴板（Clipboard API 在 headless 下有自己的脾气）
 *   · 🔴 **房主停在卡上、好友进来时，真的会被自动送进对局**
 *     —— 这是整个 P1-12 唯一会「伤主」的路径：服务端满员即开局，
 *        房主若没被及时送走，十道题的时间会在看卡片时被扣光。
 *
 * 最后一条必须真起两个会话：页面里点建房（会话 A），再用 API 以会话 B
 * 加入同一个房码 → 服务端 autoStartIfFull 就地开局 → 断言页面 A 自己跳走。
 *
 * 用法：node tests/p1-12-war-live.mjs [--base=https://www.memoryduel.com]
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

/* playwright 装在 WorkBuddy 的 node 工作区里；ESM 不认 NODE_PATH，
   所以用 createRequire 从工作区根解析（可用 PW_HOME 覆盖）。 */
const PW_HOME = process.env.PW_HOME || '/home/agentuser/.workbuddy/binaries/node/workspace/';
const { chromium } = createRequire(PW_HOME)('playwright');

const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').split('=')[1]
  || 'https://www.memoryduel.com';
const SHOT_DIR = path.resolve('p12-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 建一个服务端会话（会话 B 用，模拟「好友」） */
async function newSession() {
  const r = await fetch(`${BASE}/api/md/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  const j = await r.json();
  const d = j.data || j;
  return { pid: d.pid, token: d.token };
}

async function main() {
  /* 工作区里装的 playwright 版本与缓存里的 chromium 版本号对不上（它找 1091，
     本机是 1243），所以显式指定可执行文件，别让 playwright 自己去猜。 */
  const CACHE = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.HOME, '.cache/ms-playwright');
  const exe = fs.existsSync(CACHE)
    ? fs.readdirSync(CACHE)
      .filter((d) => /^chromium-\d+$/.test(d))
      .map((d) => path.join(CACHE, d, 'chrome-linux64/chrome'))
      .find((p) => fs.existsSync(p))
    : null;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});

  /* ── 桌面 ── */
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: [] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`${BASE}/games/knowledge-duel/lobby/?lang=en`, { waitUntil: 'domcontentloaded' });

  /* 1 · 卡片默认必须藏着 */
  const hiddenBefore = await page.locator('#kbWar').isHidden();
  check('首屏 #kbWar 是隐藏的', hiddenBefore === true);

  /* 2 · 点建房 */
  await page.locator('#kbCreateBtn').click();
  await page.locator('#kbWar').waitFor({ state: 'visible', timeout: 20000 });
  check('建房后 #kbWar 变为可见', true);

  const code = (await page.locator('#kbWarCode').innerText()).trim();
  check('房码是 6 位 [A-Z2-9]', /^[A-Z2-9]{6}$/.test(code), code);

  const linkTxt = (await page.locator('#kbWarLink').innerText()).trim();
  /* 卡片上印的是「当前 origin + /j/CODE」（去掉协议）—— 与复制出来的完全一致。
     不做 memoryduel.com 归一化：显示的串和复制的串必须是同一串，
     否则玩家会以为印错了。 */
  const host = new URL(BASE).host;
  check('卡片上印的短链形态正确', linkTxt === `${host}/j/${code}`, linkTxt);

  const startHref = await page.locator('#kbWarStart').getAttribute('href');
  check('「先开始」带上 room 参数', String(startHref).includes(`room=${code}`), startHref);

  /* 3 · 房码排版真的等宽（tabular-nums 生效时，每个字符盒宽度一致） */
  const glyphWidths = await page.evaluate(() => {
    const el = document.getElementById('kbWarCode');
    const r = document.createRange();
    const out = [];
    const node = el.firstChild;
    for (let i = 0; i < node.length; i++) {
      r.setStart(node, i); r.setEnd(node, i + 1);
      out.push(+r.getBoundingClientRect().width.toFixed(2));
    }
    return out;
  });
  const uniq = [...new Set(glyphWidths)];
  // 字距会均摊到每个字符：允许因字体 hinting 有 0.5px 级差异
  const spread = Math.max(...uniq) - Math.min(...uniq);
  check('房码字距均摊（每个字符盒宽一致）', spread <= 1.5, `宽度集合=${JSON.stringify(uniq)}`);

  const letterSpacing = await page.locator('#kbWarCode').evaluate((el) => getComputedStyle(el).letterSpacing);
  check('房码 letter-spacing 已生效', parseFloat(letterSpacing) > 5, letterSpacing);

  /* 票根虚线框真的画出来了（不是退化成一像素实线或无色） */
  const ticket = await page.locator('.kb-war-ticket').evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.borderTopStyle, width: s.borderTopWidth, color: s.borderTopColor };
  });
  check('票根是虚线框', ticket.style === 'dashed' && parseFloat(ticket.width) >= 1,
    `${ticket.style} ${ticket.width} ${ticket.color}`);

  /* 🔴 对比度：这个站历史上栽过「注释闭合符写坏 → :root 整块失效 → 按钮底色
     掉到 1:1」。房码是全卡唯一的大字，也是这张卡的全部信息量，单独锁一遍。 */
  const contrast = await page.evaluate(() => {
    const lum = (rgbStr) => {
      const m = rgbStr.match(/\d+(\.\d+)?/g).map(Number);
      const f = m.slice(0, 3).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
    };
    /* 向上找出第一个不透明祖先底色 —— 卡片本身可能有渐变 */
    const bgOf = (el) => {
      let n = el;
      while (n) {
        const bg = getComputedStyle(n).backgroundColor;
        if (bg && !/rgba?\([^)]*,\s*0\)$/.test(bg)) return bg;
        n = n.parentElement;
      }
      return 'rgb(255,255,255)';
    };
    const code = document.getElementById('kbWarCode');
    const start = document.getElementById('kbWarStart');
    const l1 = lum(getComputedStyle(code).color), l2 = lum(bgOf(code));
    const s1 = lum(getComputedStyle(start).color), s2 = lum(getComputedStyle(start).backgroundColor);
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    return { code: +ratio(l1, l2).toFixed(2), start: +ratio(s1, s2).toFixed(2) };
  });
  // 房码 ≥30px 粗体属「大文本」，AA 门槛 3:1；「先开始」按正文门槛 4.5:1
  check('房码文字对比度 ≥4.5', contrast.code >= 4.5, contrast.code + ':1');
  check('「先开始」按钮对比度 ≥4.5', contrast.start >= 4.5, contrast.start + ':1');

  /* 4 · 复制 */
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#kbWarCopy').click();
  await page.waitForTimeout(600);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  check('复制到剪贴板的是短链', clip === `${BASE}/j/${code}`, clip);

  const msgVisible = await page.locator('#kbWarMsg').isVisible();
  const msgText = msgVisible ? (await page.locator('#kbWarMsg').innerText()).trim() : '';
  check('复制后给出反馈', msgVisible && /copied|Copy/i.test(msgText), msgText);

  /* 5 · 等待状态可见 */
  const waitVisible = await page.locator('#kbWarWait').isVisible();
  check('卡片提示「等待对手」', waitVisible === true, (await page.locator('#kbWarWait').innerText()).trim());

  /* 截图：桌面 */
  await page.locator('#kbWar').screenshot({ path: path.join(SHOT_DIR, 'war-desktop.png') });

  /* 6 · 🔴 关键路径：好友加入 → 房主必须自动被送进对局 */
  const guest = await newSession();
  const joinRes = await fetch(`${BASE}/api/md/room/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Player-ID': guest.pid,
      'X-Player-Token': guest.token,
    },
    body: JSON.stringify({ code, name: 'Guest-' + guest.pid.slice(1, 5), lang: 'en' }),
  }).then((r) => r.json());
  check('好友 join 成功且服务端就地开局', !!(joinRes.ok && (joinRes.data?.started || joinRes.data?.status === 'playing')),
    `status=${joinRes.data?.status} started=${joinRes.data?.started}`);

  let navigated = false;
  try {
    await page.waitForURL(new RegExp(`room=${code}`), { timeout: 15000 });
    navigated = true;
  } catch { navigated = false; }
  check('🔴 房主被自动送进对局（没被扣光时间）', navigated, page.url());

  /* ── 移动端：布局与触控目标 ── */
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const m = await ctx2.newPage();
  await m.goto(`${BASE}/games/knowledge-duel/lobby/?lang=zh`, { waitUntil: 'domcontentloaded' });
  await m.locator('#kbCreateBtn').click();
  await m.locator('#kbWar').waitFor({ state: 'visible', timeout: 20000 });

  const box = await m.locator('#kbWar').boundingBox();
  check('移动端卡片不溢出视口', box.width <= 390, `width=${Math.round(box.width)}`);

  const targets = await m.evaluate(() => {
    const ids = ['kbWarCopy', 'kbWarShare', 'kbWarImg', 'kbWarStart'];
    return ids.map((id) => {
      const el = document.getElementById(id);
      if (!el || el.offsetParent === null) return { id, h: 0, vis: false };
      return { id, h: Math.round(el.getBoundingClientRect().height), vis: true };
    });
  });
  const smallTargets = targets.filter((t) => t.vis && t.h < 44);
  check('移动端可点元素 ≥44px', smallTargets.length === 0, JSON.stringify(targets));

  const zhTitle = (await m.locator('#kbWarTitle').innerText()).trim();
  check('中文文案生效（不是裸 key）', zhTitle === '战书已就绪', zhTitle);

  const zhStart = (await m.locator('#kbWarStart span').first().innerText()).trim();
  check('「先开始」中文文案生效', zhStart === '开始对决', zhStart);

  await m.locator('#kbWar').screenshot({ path: path.join(SHOT_DIR, 'war-mobile-zh.png') });

  /* 暗色 */
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  const dk = await ctx3.newPage();
  await dk.goto(`${BASE}/games/knowledge-duel/lobby/?lang=en`, { waitUntil: 'domcontentloaded' });
  await dk.locator('#kbCreateBtn').click();
  await dk.locator('#kbWar').waitFor({ state: 'visible', timeout: 20000 });
  await dk.locator('#kbWar').screenshot({ path: path.join(SHOT_DIR, 'war-mobile-dark.png') });
  const bg = await dk.locator('#kbWar').evaluate((el) => getComputedStyle(el).backgroundColor);
  check('暗色下卡片底色不是亮色', !/255,\s*255,\s*255/.test(bg), bg);

  /* 无未捕获异常 */
  /* 第三方噪音不算本站异常：
     · cloudflareinsights.com 的 RUM beacon 在本沙箱环境被 CORS 拦
       （它自己缺 ACAO 头，与本站代码无关） */
  const realErrors = errors.filter((e) => !/favicon|analytics|adsbygoogle|cloudflareinsights|Failed to load resource|CORS policy/i.test(e));
  check('无 JS 未捕获异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log(`  ✗ ${f.name} ${f.detail}`));
    process.exit(1);
  }
  console.log('截图目录：' + SHOT_DIR);
}

main().catch((e) => { console.error('验收脚本异常：', e); process.exit(1); });
