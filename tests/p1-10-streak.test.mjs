/* P1-10：连击乘数前端守卫（静态源码契约）
   重点：服务端与前端降级副本同档位、UI 飘火、i18n 全语种、dictVersion 一致。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const T = read('public/train.html');
const LANGS = ['en', 'zh', 'ja', 'de', 'fr', 'es'];

test('P1-10 前端连击档位与服务端严格同值', () => {
  assert.match(T, /var STREAK_MULT = \[1, 1, 1\.2, 1\.5\]/,
    'STREAK_MULT 必须是 [1,1,1.2,1.5]，与 lib/duel-tiers.js 对齐');
  assert.match(T, /var STREAK_FIRE_AT = 3/);
  assert.match(T, /function streakMult\(n\)[\s\S]{0,240}return STREAK_MULT\[Math\.min\(Math\.floor\(n\), STREAK_MULT\.length - 1\)\]/,
    'streakMult 必须在 ≥3 时封顶');
  assert.match(T, /function streakStep\(prev, correct\)[\s\S]{0,260}if \(!correct\) return \{ streak: 0, mult: 1 \};/,
    '答错必须清零');
});

test('P1-10 scoreAt 把连击倍率与末题倍率相乘', () => {
  assert.match(T, /var roundM = n > 1 && round === n - 1 \? FINAL_MULT : 1;/);
  assert.match(T, /return Math\.round\(base \* roundM \* streakMult\(streakBefore\)\);/,
    '末题与连击必须相乘而非相加');
});

test('P1-10 三条降级路径都接入连击', () => {
  // revealLocal
  assert.match(T, /var before = localStreakBefore\(B\.answers, round\);/);
  assert.match(T, /streak: step\.streak, streakMult: step\.mult, totalMult: roundM \* step\.mult/);
  // localPracticeResult
  assert.match(T, /var before = youStreak;\s*var step = streakStep\(before, correct\);/);
  // startPracticeBattle 的 bot
  assert.match(T, /var before = botStreak;\s*var step = streakStep\(before, correct\);\s*botStreak = step\.streak;/);
  assert.match(T, /streak: step\.streak, gained: gained \};/, 'bot 节奏要带 streak 供结算展示');
});

test('P1-10 揭晓显示连击标记并在连对 3 题时飘火', () => {
  assert.match(T, /var fire = sm > 1 \? ' <i class="ex-streak">🔥 ×' \+ sm \+ '<\/i>' : '';/);
  assert.match(T, /if \(r\.correct && stk >= STREAK_FIRE_AT\) showStreakToast\(stk\);/);
  assert.match(T, /function showStreakToast\(n\)[\s\S]{0,700}setTimeout\(function \(\) \{[\s\S]{0,120}\}, 1400\);/,
    '飘火节点必须自毁，不能堆在 DOM 里');
});

test('P1-10 飘火 i18n 使用 t() 正确的第 4 参兜底', () => {
  assert.match(T, /window\.t\('duel\.streak_toast', \{ n: n \}, undefined, fallback\)/,
    '第 2 参是插值变量、第 4 参才是兜底，别再踩 T(key,fallback) 的坑');
  assert.ok(T.includes('.replace(/\\{n\\}/g, String(n))'),
    '兜底文案里的 {n} 要能被替换');
});

test('P1-10 CSS 含连击标记与飘火动画', () => {
  assert.match(T, /\.battle-explain \.ex-streak, \.res-review \.ex-streak\{/);
  assert.match(T, /\.streak-toast\{position:fixed/);
  assert.match(T, /@keyframes streak-pop\{/);
  assert.match(T, /html\[data-theme="dark"\] \.streak-toast\{/, '暗色主题要有阴影适配');
});

test('P1-10 六语词典都新增 duel.streak_toast 且含 {n} 占位符', () => {
  for (const l of LANGS) {
    const d = JSON.parse(read(`public/i18n/${l}.json`));
    const v = d && d.duel && d.duel.streak_toast;
    assert.ok(v, `${l} 缺 duel.streak_toast`);
    assert.match(v, /\{n\}/, `${l} 的 duel.streak_toast 缺 {n} 占位符`);
    assert.match(v, /🔥/, `${l} 的 duel.streak_toast 缺 🔥`);
  }
});

test('P1-10 dictVersion 与 VERSION 全站一致', () => {
  const v = Number(read('public/i18n/VERSION').trim());
  assert.ok(Number.isInteger(v) && v >= 72, `VERSION 应 >= 72，实际 ${v}`);
  const htmls = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.html')) htmls.push(rel);
    }
  };
  walk('.');
  const withKey = htmls.filter((f) => /dictVersion:\s*\d+/.test(read(f)));
  assert.ok(withKey.length >= 28, `应有至少 28 个 html 带 dictVersion，实际 ${withKey.length}`);
  for (const f of withKey) {
    const m = read(f).match(/dictVersion:\s*(\d+)/);
    assert.equal(Number(m[1]), v, `${f} 的 dictVersion 与 VERSION 不一致`);
  }
});

test('P1-10 日挑战前端未被引入连击乘数', () => {
  // 服务端 kdaily.js 不在前端仓库；这里锁「前端日挑战没有加连击」的契约
  for (const f of ['public/js/daily-teaser.mjs', 'src/pages/daily-game.ts']) {
    const dc = read(f);
    assert.ok(!/streakMult|STREAK_MULT/.test(dc), `${f} 不应引入连击乘数`);
  }
});
