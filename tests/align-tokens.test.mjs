/**
 * 三站对齐层守卫（2026-11-05 · 方案 A）
 * ------------------------------------------------------------
 * 背景：三仓 public/shared/tokens.css 哈希一致，只能证明「文件同步了」，
 * 不能证明「设计落地了」。首页/大厅曾完全不引用共享 token，对战页引用的是
 * 另一份旧 DUEL-DS（琥珀品牌槽位）。本测试把对齐层与真相源逐项机器比对，
 * 并守卫三页确实消费了对齐层，避免下次改版又漂回去。
 *
 * 纯 fs + node:assert，不联网、不启浏览器，可进 CI。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 取出某选择器块内的自定义属性（跳过 var() 引用，只留字面值） */
function vars(src, selector) {
  const start = src.indexOf(selector);
  if (start < 0) return {};
  const open = src.indexOf('{', start);
  if (open < 0) return {};
  let depth = 0;
  let end = open;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}') { depth--; if (depth === 0) break; }
  }
  const block = src.slice(open + 1, end);
  const out = {};
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    const v = m[2].trim();
    if (!v.startsWith('var(')) out[m[1]] = v;
  }
  return out;
}

const norm = (v) => String(v).replace(/\s+/g, '').toLowerCase();

/** 对齐别名 → fe-shared 真相源变量名（亮色 / 暗色各一份） */
const LIGHT_MAP = {
  'md-page-bg': 'ink',
  'md-surface': 'ink2',
  'md-surface-2': 'ink3',
  'md-line': 'line',
  'md-line-strong': 'line2',
  'md-text': 'paper',
  'md-text-mute': 'mute',
  'md-text-mute-2': 'mute2',
  'md-brand': 'brand-600',
  'md-brand-strong': 'brand-700',
  'md-brand-soft': 'brand-50',
  'md-brand-ring': 'brand-ring',
  'md-on-brand': 'on-brand',
  'md-ember': 'ember',
  'md-ember-soft': 'ember-soft',
  'md-success': 'success',
  'md-danger': 'danger',
  'md-r-card': 'r-card',
};
const DARK_MAP = {
  'md-page-bg': 'ink',
  'md-surface': 'ink2',
  'md-surface-2': 'ink3',
  'md-line': 'line',
  'md-line-strong': 'line2',
  'md-text': 'paper',
  'md-text-mute': 'mute',
  'md-text-mute-2': 'mute2',
  'md-brand': 'brand',
  'md-brand-strong': 'brand-hover',
  'md-brand-soft': 'brand-subtle',
  'md-brand-ring': 'brand-ring',
  'md-on-brand': 'on-brand',
};

const align = read('public/shared/align.css');
const truth = read('public/shared/tokens.css');
const aLight = vars(align, ':root');
const aDark = vars(align, 'html[data-theme="dark"]');
const tLight = vars(truth, ':root');
const tDark = vars(truth, 'html[data-theme="dark"]');

function checkMap(label, a, t, map) {
  for (const [alias, source] of Object.entries(map)) {
    assert.ok(a[alias], `align.css ${label} 缺少 --${alias}`);
    assert.ok(t[source], `tokens.css ${label} 缺少 --${source}`);
    assert.equal(
      norm(a[alias]), norm(t[source]),
      `${label} --${alias} 必须等于真相源 --${source}（实得 ${a[alias]} vs ${t[source]}）`
    );
  }
}

test('对齐层亮色别名逐项等于 fe-shared 真相源', () => checkMap('亮色', aLight, tLight, LIGHT_MAP));
test('对齐层暗色别名逐项等于 fe-shared 真相源', () => checkMap('暗色', aDark, tDark, DARK_MAP));

test('主 CTA 亮暗两态都有成对的 on-brand 文字色，且不是琥珀配白字', () => {
  assert.equal(norm(aLight['md-on-brand']), '#ffffff');
  assert.notEqual(norm(aLight['md-brand']), norm(aLight['md-ember']));
  assert.equal(norm(aDark['md-on-brand']), '#0e1026');
  assert.notEqual(norm(aDark['md-on-brand']), '#ffffff', '暗色亮靛蓝底配白字不合规');
});

test('深色舞台带占比硬上限 ≤40% 视口', () => {
  const h = aLight['md-band-max'] || '';
  const m = h.match(/^(\d+(?:\.\d+)?)vh$/);
  assert.ok(m, `--md-band-max 必须是 Nvh，实得 ${h}`);
  assert.ok(Number(m[1]) <= 40, `深色区上限 ${m[1]}vh 超过 40% 视口`);
});

const PAGES = [
  'index.html',
  'games/knowledge-duel/lobby/index.html',
  'public/train.html',
];

test('首页 / 大厅 / 对战页都消费同一份对齐层', () => {
  for (const p of PAGES) {
    assert.match(read(p), /href="\/shared\/align\.css(?:\?[^"]*)?"/, `${p} 必须引入 /shared/align.css`);
  }
});

test('三页 theme-color 统一冷纸底，且早脚本在暗色下改成同一暗底', () => {
  for (const p of PAGES) {
    const s = read(p);
    assert.match(s, /<meta name="theme-color" content="#F4F5F9">/, `${p} theme-color 必须是 #F4F5F9`);
    assert.match(s, /#12131F/, `${p} 早脚本/主题层必须在暗色下写 #12131F`);
  }
});

test('自造金色 #F5B300 已从三页皮肤层清除（统一走 --md-ember）', () => {
  const files = ['src/styles/home-arena.css', 'src/styles/knowledge-lobby.css', 'public/train.html'];
  for (const f of files) {
    assert.doesNotMatch(read(f), /#F5B300/i, `${f} 仍残留自造金色 #F5B300`);
  }
});
