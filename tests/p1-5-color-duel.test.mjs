/**
 * P1-5 Color Recall 双人对战 · 单测
 * ────────────────────────────────────────────────────────────────
 * 背景：后端早已就绪（ROOM_GAMES 含 color-recall、publicView 下发 colors、
 *      judgeAgainst 有 color 判分含脏字段兜底），P1-5 补的是**前端**。
 *
 * 本套锁死四类容易「上线才发现」的问题：
 *  1. 契约对齐 —— 前端发的答案形状必须与后端 judgeAgainst 期望的一致
 *  2. 公平性   —— 对战里滑块默认值**不能**等于目标色，否则不动就满分
 *  3. 路由与出口 —— 三款游戏各自的 URL、返回路径、回首页路径不许串
 *  4. 六语完整性 —— 少一个键页面上就会直接显示 key 原文
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DUEL_TS = path.join(ROOT, 'src/pages/duel-sequence.ts');
const COLOR_HTML = path.join(ROOT, 'games/color-recall/index.html');

const src = fs.readFileSync(DUEL_TS, 'utf8');
const readJson = (l) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n', `${l}.json`), 'utf8'));
const LANGS = ['en', 'zh', 'ja', 'es', 'fr', 'de'];

/* ═══════════════════════════════════════════════════════════════
   1. 路由：三款游戏各自独立 URL
   ═══════════════════════════════════════════════════════════════ */
test('三款对战游戏各有独立 URL，且由 pathname 推断 game', () => {
  const m = /const GAME: string =([\s\S]*?);\n/.exec(src);
  assert.ok(m, '应能定位 GAME 定义');
  const body = m[1];
  // 🔴 源码里路径是写在正则字面量里的，斜杠被转义成 \/：
  //     /\/games\/number-recall\//  ← 抓出来是 \/games\/number-recall\//
  //    直接查 '/games/number-recall/' 必然落空，且报错信息完全指不到点上。
  assert.ok(body.includes('games\\/number-recall\\/'), 'number-recall 必须由路径推断');
  assert.ok(body.includes('games\\/color-recall\\/'), 'color-recall 必须由路径推断');
  assert.ok(body.includes('location.pathname'), '必须按 pathname 判断而非 query（保证 SEO 落地页各自独立）');
  const iNum = body.indexOf("'number-recall'");
  const iCol = body.indexOf("'color-recall'");
  assert.ok(iNum > -1 && iCol > -1, '两个显式分支都要在');
  assert.ok(iNum < iCol, 'number 分支必须在 color 之前（顺序影响可读性）');
  // 🔴 兜底判断不能锚行尾：缩进换行是 prettier 常规排版，
  //    一旦格式化就锚失败，测试变成「排版即失败」的无意义红灯。
  assert.ok(/:\s*'sequence-memory'\s*$/.test(body.trim()),
    '兜底必须是 sequence-memory');
});

test('每个游戏页都存在且引同一份内核（不复制粘贴出分叉实现）', () => {
  for (const g of ['sequence-memory', 'number-recall', 'color-recall']) {
    const p = path.join(ROOT, 'games', g, 'index.html');
    assert.ok(fs.existsSync(p), `${g}/index.html 应存在`);
    const html = fs.readFileSync(p, 'utf8');
    assert.ok(html.includes('/src/pages/duel-sequence.ts'),
      `${g} 必须引同一份 duel-sequence.ts，不得复制实现`);
    assert.ok(html.includes('/shared/duel-room.js'), `${g} 必须引 duel-room.js`);
  }
});

test('内部跳转不许硬编码 sequence-memory（否则从 color 点「再来」会跳到别的游戏）', () => {
  assert.ok(/const GAME_HOME = GAME === 'number-recall'/.test(src), '应定义 GAME_HOME');
  assert.ok(src.includes("'/games/color-recall/'"), 'GAME_HOME 必须含 color-recall 分支');
  // 三处跳转（结果页再来 / 断线重连 / 顶层兜底）都要用 GAME_HOME
  const hrefs = [...src.matchAll(/location\.href = ([^;]+);/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 3, `应有多处跳转，实际 ${hrefs.length}`);
  for (const h of hrefs) {
    assert.ok(!/'\/games\/sequence-memory\/'/.test(h),
      `不该出现硬编码路径：location.href = ${h}`);
  }
});

/* ═══════════════════════════════════════════════════════════════
   2. 契约：答案形状必须与后端 judgeExpect 对齐
   ═══════════════════════════════════════════════════════════════ */
test('颜色答案以 HSB 对象数组提交（不是颜色名字符串）', () => {
  // 契约来自后端 publicView / judgeAgainst：[{h,s,b} × N]
  assert.ok(/answers\.push\(\{ h: \+h\.value, s: \+s\.value, b: \+b\.value \}\)/.test(src),
    '必须按 h/s/b 三个字段 push');
  assert.ok(/answer = answers;/.test(src), '最终 answer 必须是对象数组');
  // 解析时也要转成对象，喂字符串会让 hsbToCss 算出 NaN 度色
  assert.ok(/c\.h\)\s*\|\|\s*0,\s*s:\s*Number\(c && c\.s\)\s*\|\|\s*0,\s*b:\s*Number\(c && c\.b\)\s*\|\|\s*0/.test(src),
    '解析 colors 时必须逐字段 Number() 兜底');
});

test('服务端没下发颜色时报错，而不是拿空数组往下走', () => {
  assert.ok(/const noPuzzle = isNumber \? !target\.length : isColor \? !colors\.length : !seq\.length;/.test(src),
    '颜色关的空数组必须被当成「未下发题目」');
  assert.ok(/服务端未下发 \$\{GAME\} 题目/.test(src), '应有明确报错文案');
});

/* ═══════════════════════════════════════════════════════════════
   3. 🔴 公平性：对战里滑块默认值不能等于目标色
   ═══════════════════════════════════════════════════════════════ */
test('对战颜色关的滑块默认值是中性值，不是目标色（否则不动就满分）', () => {
  const seg = src.slice(src.indexOf('} else if (isColor) {'), src.indexOf('/* ── 提交'));
  // 🔴 daily 的 playColor 里默认值就是目标色（单人练习，玩家走个形式）；
  //    对战里若照抄，玩家什么都不动就拿满分，比赛直接失去意义。
  assert.ok(/id="h" min="0" max="359" value="0"/.test(seg),
    'H 滑块初值必须是中性 0，不能是目标色相');
  assert.ok(/id="s" min="20" max="100" value="50"/.test(seg),
    'S 滑块初值必须是中性 50');
  assert.ok(/id="b" min="10" max="95" value="50"/.test(seg),
    'B 滑块初值必须是中性 50');
  // 反向防护：不允许出现 value="${Math.round(tgt.x)}" 这种把目标写进初值
  assert.ok(!/value="\$\{Math\.round\(tgt\./.test(seg),
    '禁止把目标色写进滑块初值');
});

test('颜色关展示时长与 daily 一致（玩家不必在两种玩法间换预期）', () => {
  const daily = fs.readFileSync(path.join(ROOT, 'src/pages/daily-game.ts'), 'utf8');
  const dailyMs = /await sleep\((\d{4})\);\s*\n\s*row\.innerHTML = ''/.exec(daily);
  assert.ok(dailyMs, '应能从 daily-game.ts 定位颜色展示时长');
  const m = /const COLOR_SHOW_MS = (\d+);/.exec(src);
  assert.ok(m, 'duel 侧应定义 COLOR_SHOW_MS');
  assert.equal(Number(m[1]), Number(dailyMs[1]),
    '两侧展示时长必须一致，否则同一游戏两种玩法观感不同');
});

test('hsbToCss 与 daily 的实现逐字一致（同一颜色不能两处显示不同）', () => {
  const daily = fs.readFileSync(path.join(ROOT, 'src/pages/daily-game.ts'), 'utf8');
  const grab = (text) => {
    const i = text.indexOf('function hsbToCss');
    assert.ok(i > -1, '两侧都应定义 hsbToCss');
    const start = text.lastIndexOf('\n', i) + 1;
    const end = text.indexOf('\n}', i);
    assert.ok(end > i, '应能定位函数结尾');
    return text.slice(start, end + 2).trim();
  };
  assert.equal(grab(src), grab(daily),
    'hsbToCss 两份实现已分叉 —— 复制粘贴的纯函数必须保持一致，否则同色不同显示');
});

/* ═══════════════════════════════════════════════════════════════
   4. 六语文案完整性
   ═══════════════════════════════════════════════════════════════ */
test('六语都齐 duel.col_* 五个键 + home_v2.game_col_d', () => {
  for (const L of LANGS) {
    const d = readJson(L);
    for (const k of ['col_title', 'col_help', 'col_ready_hint', 'col_pick', 'col_foot_hint']) {
      assert.equal(typeof d.duel?.[k], 'string', `${L}.duel.${k} 缺失`);
      assert.ok(d.duel[k].trim().length, `${L}.duel.${k} 是空串`);
      assert.notEqual(d.duel[k], k, `${L}.duel.${k} 等于 key 原文（漏翻）`);
    }
    assert.equal(typeof d.home_v2?.game_col_d, 'string', `${L}.home_v2.game_col_d 缺失`);
    assert.notEqual(d.home_v2.game_col_d, 'game_col_d', `${L} 首页文案漏翻`);
  }
});

test('col_pick 六语都保留 {n}/{total} 占位符', () => {
  // 🔴 页面靠 .replace('{n}',…) / .replace('{total}',…) 填值。
  //    译文里漏掉占位符 = 页面直接显示 "{n}"，且**不报错**。
  for (const L of LANGS) {
    const v = readJson(L).duel.col_pick;
    assert.ok(v.includes('{n}'), `${L}.col_pick 缺 {n}`);
    assert.ok(v.includes('{total}'), `${L}.col_pick 缺 {total}`);
  }
});

test('色轮无障碍属性齐备（wheel 是 role=application 的自定义控件）', () => {
  const seg = src.slice(src.indexOf('} else if (isColor) {'), src.indexOf('/* ── 提交'));
  assert.ok(/id="wheel"[^>]*role="application"/.test(seg), '色轮需 role=application');
  assert.ok(/aria-label="\$\{esc\(t\('dc\.col_wheel'/.test(seg), '色轮需 aria-label');
  assert.ok(/aria-label="\$\{esc\(t\('dc\.col_target'/.test(seg), '目标色块需 aria-label');
  // 三个滑块都要有可读输出，色盲用户靠数值判断
  for (const id of ['ho', 'so', 'bo']) {
    assert.ok(seg.includes(`id="${id}"`), `缺 ${id} 输出`);
  }
});

/* ═══════════════════════════════════════════════════════════════
   5. 入口：首页 + sitemap
   ═══════════════════════════════════════════════════════════════ */
test('首页游戏矩阵含 color-recall 卡片', () => {
  const home = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(home.includes('href="/games/color-recall/"'), '首页应有入口');
  assert.ok(home.includes('data-i18n="duel.col_title"'), '卡片标题应走 i18n');
  assert.ok(home.includes('data-i18n="home_v2.game_col_d"'), '卡片描述应走 i18n');
});

test('vite.config 必须注册 color 入口（否则构建静默丢弃，线上 404）', () => {
  // 🔴 本轮真踩：只建了 games/color-recall/index.html 就以为完事，
  //    构建**零报错**、dist 里根本没有该目录、线上 404。
  //    Vite 未注册的 MPA 入口就是被静默丢掉，没有任何提示。
  //    这条断言的作用是让「忘了注册」变成一次明确红灯。
  const cfg = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
  assert.ok(/colorDuel:\s*resolve\(here,\s*'games\/color-recall\/index\.html'\)/.test(cfg),
    'color 入口未注册进 rollupOptions.input —— 构建会静默丢弃、线上 404');
});

test('每个 games/<slug>/index.html 都已注册进 vite input', () => {
  // 通用防回归：不针对 color 写死，任何新页面漏注册都会被抓到
  const cfg = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
  const dirs = fs.readdirSync(path.join(ROOT, 'games'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.ok(dirs.length > 0, '应有游戏目录');
  for (const d of dirs) {
    const rel = `games/${d}/index.html`;
    assert.ok(cfg.includes(rel), `${rel} 未注册进 vite input —— 构建静默丢弃、线上 404`);
  }
});

test('sitemap 含 color-recall 落地页', () => {
  const sm = fs.readFileSync(path.join(ROOT, 'public/sitemap.xml'), 'utf8');
  assert.ok(sm.includes('https://memoryduel.com/games/color-recall/'),
    '新落地页不进 sitemap 等于对 SEO 不存在');
});

test('color 页面 SEO 头与另两款对齐（title/canonical/OG/hreflang）', () => {
  const html = fs.readFileSync(COLOR_HTML, 'utf8');
  for (const needle of [
    // 2026-10-13：title/meta_desc 已接入 i18n 范式（data-i18n-title + data-i18n），
    // 裸标签断言会随范式升级而误报，故改为断言「属性齐全 + 键名正确 + 英文兜底文案不变」。
    '<title data-i18n-title="colduel.title">Colour Recall Duel · MemoryDuel</title>',
    '<meta name="description" data-i18n="colduel.meta_desc"',
    '<link rel="canonical" href="https://memoryduel.com/games/color-recall/" />',
    'property="og:url" content="https://memoryduel.com/games/color-recall/"',
    'name="twitter:card" content="summary_large_image"',
    'hreflang="x-default"',
  ]) {
    assert.ok(html.includes(needle), `color 页缺 ${needle}`);
  }
});

/* ═══════════════════════════════════════════════════════════════
   5b. SEO i18n 完整性（2026-10-13 全面复查新增）
   原来四页的 title/description 全是硬编码英文，切到中/日/西/法/德时
   浏览器标签页与搜索结果标题仍是英文。已按站点既有范式接入 data-i18n-title。
   ═══════════════════════════════════════════════════════════════ */
test('三款对战页 + 每日挑战的 title/description 均接入六语 i18n', () => {
  const NS = {
    'games/color-recall/index.html': 'colduel',
    'games/sequence-memory/index.html': 'seqduel',
    'games/number-recall/index.html': 'numduel',
    'games/daily-challenge/index.html': 'dc',
  };
  const LANGS = ['en', 'zh', 'ja', 'es', 'fr', 'de'];
  const dicts = {};
  for (const l of LANGS) {
    dicts[l] = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n', l + '.json'), 'utf8'));
  }

  for (const [rel, ns] of Object.entries(NS)) {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(html.includes(`data-i18n-title="${ns}.title"`), `${rel} 未接 data-i18n-title`);
    assert.ok(html.includes(`data-i18n="${ns}.meta_desc"`), `${rel} 未接 data-i18n meta_desc`);

    // 六语都必须在，且**互不相同**（防「复制英文到六语」这种假翻译）
    const titles = LANGS.map((l) => dicts[l][ns] && dicts[l][ns].title);
    const descs = LANGS.map((l) => dicts[l][ns] && dicts[l][ns].meta_desc);
    for (const [i, l] of LANGS.entries()) {
      assert.ok(titles[i] && titles[i].trim(), `${rel} ${l} 缺 ${ns}.title`);
      assert.ok(descs[i] && descs[i].trim(), `${rel} ${l} 缺 ${ns}.meta_desc`);
    }
    // 允许 en 之外的偶然相同（如产品名 MemoryDuel），但不能六语完全一致
    assert.ok(new Set(titles).size >= 3, `${rel} 六语 title 几乎相同，疑似未翻译：${JSON.stringify(titles)}`);
    assert.ok(new Set(descs).size >= 3, `${rel} 六语 meta_desc 几乎相同，疑似未翻译`);
  }
});

test('四页 hreflang 覆盖六语 + x-default（此前只有 en + x-default）', () => {
  for (const rel of [
    'games/color-recall/index.html',
    'games/sequence-memory/index.html',
    'games/number-recall/index.html',
    'games/daily-challenge/index.html',
  ]) {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const c of ['zh-CN', 'en', 'ja', 'es', 'fr', 'de']) {
      assert.ok(
        html.includes(`hreflang="${c}"`),
        `${rel} 缺 hreflang="${c}"`,
      );
    }
    assert.ok(html.includes('hreflang="x-default"'), `${rel} 缺 x-default`);
  }
});

/* ═══════════════════════════════════════════════════════════════
   6. 回归：另两款没被改坏
   ═══════════════════════════════════════════════════════════════ */
test('sequence 与 number 的文案与判定仍走原有分支', () => {
  const entry = src.slice(src.indexOf('const COPY'), src.indexOf('function renderEntry'));
  assert.ok(entry.length > 100, `COPY 表段应存在，实际长度 ${entry.length}`);
  for (const k of ['seq_title', 'seq_ready_hint', 'num_title', 'num_ready_hint', 'col_title']) {
    assert.ok(entry.includes(k), `COPY 表缺 ${k}`);
  }
  // number 仍是「位数满即提交」，不能被颜色分支污染
  assert.ok(/ans\.value\.length === target\.length/.test(src), 'number 的自动提交判定应保留');
  assert.ok(/if \(picked\.length >= seq\.length\)/.test(src), 'sequence 的点满判定应保留');
});

test('配色图标三款各不相同', () => {
  const m = /const ICON = GAME === 'number-recall' \? '([^']+)' : GAME === 'color-recall' \? '([^']+)' : '([^']+)'/.exec(src);
  assert.ok(m, 'ICON 应是三路分支');
  assert.equal(m[2], '🎨', 'color 图标应为调色板');
  const uniq = new Set([m[1], m[2], m[3]]);
  assert.equal(uniq.size, 3, '三款图标必须互不相同（否则比分页分不清谁是谁）');
});