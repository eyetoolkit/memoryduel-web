/**
 * 首页主 CTA hover 态对比度 + 颜色反馈验收（2026-10-15）
 * ────────────────────────────────────────────────────────────
 * 为什么单独一个文件：
 *   audit-design-tokens.mjs 只测静态态，且没启用 DOM/CSS 域，
 *   而 hover 必须靠 CSS.forcePseudoState 才能量到 —— 这正是
 *   「暗色 hover 对比度不足」被记错、又一直没人实测的根因。
 *
 * 覆盖两条判据：
 *   1. 对比度：base 与 hover 两态在明暗两主题下都 ≥ 4.5:1
 *   2. 颜色反馈：hover 的底色必须**真的变**（否则按钮没有 hover 反馈）
 *
 * 🔴 判据 2 不是「顺手加的」。原先 .btn-primary:hover 吃 --orange-deep，
 *    而亮色下 --orange-ink 与 --orange-deep 同为 #C2410C、暗色下又被
 *    嵌套规则 html[data-theme="dark"] :is(.btn-primary)（0,2,1）压过
 *    .btn-primary:hover（0,2,0）—— 两个主题 hover 都毫无颜色变化，
 *    只剩 1px 位移。肉眼极易漏，且一旦有人删掉那条嵌套覆盖，
 *    hover 会立刻翻成亮橙 #F97316（白字 2.80:1）。
 *
 * 🔴 工具自检：forcePseudoState 若失效，hover 态会静默读成 base 态，
 *    判据 1 全绿但什么都没测到。故必须断言 transform 确实变了。
 *
 * 用法：node tests/home-hover-contrast.mjs [origin]
 *   默认跑生产 https://www.memoryduel.com
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ORIGIN = process.argv[2] || 'https://www.memoryduel.com';
const SEL = process.argv[3] || '.btn-primary';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9334;
const prof = path.join(process.env.TEMP || '.', 'md-hover-' + process.pid);
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox',
  '--disable-gpu', '--no-proxy-server', '--lang=en-US',
  `--user-data-dir=${prof}`, 'about:blank',
], { stdio: 'ignore' });

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log(`  ok   ${m}`); }
  else { fail++; console.log(`  FAIL ${m}${extra ? '  → ' + extra : ''}`); }
};

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((x) => x.type === 'page');
  } catch (_) {}
}
if (!target) { console.log('无法连接浏览器'); proc.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { err: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const lum = (rgb) => 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
/** 前景带 alpha 时先与背景合成再算 —— 🔴 不合成会算错 */
function ratio(fgStr, bgStr) {
  const p = (s) => { const m = String(s).match(/rgba?\(([^)]+)\)/); const a = m[1].split(',').map(Number); return { rgb: [a[0], a[1], a[2]], a: a.length > 3 ? a[3] : 1 }; };
  const F = p(fgStr), B = p(bgStr);
  const cmp = F.rgb.map((c, i) => Math.round(c * F.a + B.rgb[i] * (1 - F.a)));
  const [l1, l2] = [lum(cmp), lum(B.rgb)].sort((x, y) => y - x);
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}

await send('Page.enable'); await send('Runtime.enable');
await send('DOM.enable'); await send('CSS.enable');

const READ = `(() => {
  const e = document.querySelector(${JSON.stringify(SEL)});
  if (!e) return null;
  const s = getComputedStyle(e);
  return { bg: s.backgroundColor, fg: s.color, tf: s.transform };
})()`;

const got = {};
/* 🔴 每个组合都重载：CSS.forcePseudoState 传空数组**清不掉**已强制的伪状态，
   会把 hover 残留带进下一次测量，症状是「非 hover 态也有 transform」。 */
for (const theme of ['light', 'dark']) {
  for (const hover of [false, true]) {
    await send('Page.navigate', { url: ORIGIN + '/' });
    await sleep(3200);
    await ev(`document.documentElement.setAttribute('data-theme','${theme}')`);
    await sleep(400);
    const doc = await send('DOM.getDocument', { depth: 0 });
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: SEL });
    if (!q.result?.nodeId) { got[`${theme}-${hover}`] = null; continue; }
    if (hover) await send('CSS.forcePseudoState', { nodeId: q.result.nodeId, forcedPseudoClasses: ['hover'] });
    await sleep(300);
    got[`${theme}-${hover}`] = await ev(READ);
  }
}

console.log(`\n═══ ${SEL} hover 态验收 — ${ORIGIN} ═══`);

/* ── 0. 工具自检：伪状态必须真的生效 ── */
const lb = got['light-false'], lh = got['light-true'];
const db = got['dark-false'], dh = got['dark-true'];
ok(!!lb && !!lh && !!db && !!dh, '四个组合都取到元素',
  JSON.stringify({ lb: !!lb, lh: !!lh, db: !!db, dh: !!dh }));
ok(!!lb && lb.tf !== lh?.tf, 'forcePseudoState 确实生效（transform 变化）',
  `base=${lb?.tf} hover=${lh?.tf}`);
ok(!!db && db.tf === 'none', '暗色 base 态无残留伪状态', `tf=${db?.tf}`);

/* ── 1. 对比度：四态都要达标 ── */
for (const [k, label] of [['light-false', '亮色 base'], ['light-true', '亮色 hover'],
  ['dark-false', '暗色 base'], ['dark-true', '暗色 hover']]) {
  const g = got[k];
  if (!g) { ok(false, `${label} 对比度 ≥4.5:1`, '取不到元素'); continue; }
  const r = ratio(g.fg, g.bg);
  ok(r >= 4.5, `${label} 对比度 ≥4.5:1（实测 ${r}:1，${g.bg}）`,
    r < 4.5 ? `${g.fg} on ${g.bg}` : '');
}

/* ── 2. 颜色反馈：hover 底色必须真的变 ── */
for (const [a, b, label] of [['light-false', 'light-true', '亮色'], ['dark-false', 'dark-true', '暗色']]) {
  const A = got[a], B = got[b];
  if (!A || !B) { ok(false, `${label} hover 有颜色反馈`, '取不到元素'); continue; }
  ok(A.bg !== B.bg, `${label} hover 底色发生变化（有反馈）`, `base=${A.bg} hover=${B.bg}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
proc.kill();
process.exit(fail ? 1 : 0);
