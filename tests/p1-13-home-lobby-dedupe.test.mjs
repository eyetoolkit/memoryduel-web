/**
 * P1-13 · 首页三模式区块去重复 · 单测
 * ────────────────────────────────────────────────────────────────
 * 原需求只有一行「首页 + 大厅合并 → 删 1 个页面 → 减维护面」。
 * 实地核对后选了**删首页重复区块**而不是真删页：
 *
 *   · 首页 = 营销落地页（sitemap priority 1.0，hero + 三步 + 榜单 + CTA）
 *   · 大厅 = 操作页（priority 0.8，分类 + 难度 + 四模式 + 规则）
 *   两页内容几乎不重叠，唯一重复是首页那三张模式卡 —— 它们**全部
 *   指向大厅**，玩家要连点两次「选模式」。真正该删的是这层假入口。
 *   真删页面会让 7 个下线游戏的 301 落点、sitemap、两套 CSS、多个测试
 *   一起震动，收益（少一个文件）远小于代价。
 *
 * 所以这组测试的红线是：**删的是入口，不是功能**。
 *  1. 首页不再有三模式区块，也没有指向它的死锚点
 *  2. 首页该留的入口一个不少（AI 直达 / 大厅 / 每日 / 榜单 / 终局 CTA）
 *  3. 大厅四种模式 + 分类 + 难度 + 规则全在
 *  4. 7 个下线游戏的 301 仍指向大厅，sitemap 仍收录大厅
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HOME = read('index.html');
const LOBBY_HTML = read('games/knowledge-duel/lobby/index.html');
const REDIRECTS = read('public/_redirects');
const SITEMAP = read('public/sitemap.xml');

/* ═══════════ 1 · 重复区块真的没了，且没有留下死链接 ═══════════ */

test('首页不再有三模式区块与模式卡', () => {
  assert.ok(!HOME.includes('class="ar-modes"'), 'ar-modes 区块还在 —— 玩家仍要点两次选模式');
  assert.ok(!HOME.includes('ar-mode-grid'), '模式卡网格还在');
  assert.ok(!HOME.includes('ar-mode-card'), '仍有单张模式卡');
  /* 不在这里禁 data-stage="live"：P1-13 把它移到了 hero 的「Play a friend」
     CTA 上，filter-sitemap.mjs 仍靠它判定上线游戏（见下面专门那条测试）。
     这里只禁「模式卡上的 live 标记」这种旧形态。 */
  assert.ok(!/class="gcard"[^>]*data-stage="live"/.test(HOME), '模式卡上的 live 标记还在');
});

test('首页没有任何指向 #modes 的死锚点', () => {
  assert.ok(!HOME.includes('href="#modes"'),
    '删了区块却留着 #modes 导航项 —— 点了只会跳回页顶，是最容易被忽略的半成品');
  assert.ok(!HOME.includes('home_v2.features_nav'),
    'Features 导航项仍挂在首页（它原本唯一的目标就是被删掉的区块）');
});

test('删除处留了说明注释，避免后人以为是误删', () => {
  assert.ok(HOME.includes('P1-13 · 三模式区块已移除'),
    '没有留注释 —— 半年后没人记得为什么首页少了三张卡，大概率会被"补回来"');
});

/* ═══════════ 2 · 首页该留的入口一个不少 ═══════════ */

test('hero 两条主 CTA 保留：AI 直达 + 进大厅选模式', () => {
  assert.ok(HOME.includes('id="startAiBtn"'), 'AI 直达按钮丢了 —— 首页失去「一秒开打」能力');
  assert.ok(/id="startAiBtn"[\s\S]{0,400}data-i18n="home_v3\.cta_main"/.test(HOME));
  assert.ok(HOME.includes('href="/games/knowledge-duel/lobby/"'),
    '大厅入口丢了 —— 删掉模式卡后，这是玩家找到分类/难度/房码的唯一路径');
});

test('每日挑战条 / 榜单 / 终局 CTA 都还在', () => {
  assert.ok(HOME.includes('id="arDaily"'), '每日挑战入口丢了（P0-3 的成果）');
  assert.ok(HOME.includes('id="topRankList"'), '榜单容器丢了');
  assert.ok(HOME.includes('id="ecoCard"'), '金币卡丢了');
  assert.ok(HOME.includes('id="play-now"'), '终局 CTA 丢了');
  assert.ok(HOME.includes('/train.html?cat=general&amp;mode=ai'), '终局 CTA 的直达链接丢了');
});

test('导航四项有效：Play / How / Leaderboard / Sign in', () => {
  for (const anchor of ['#play', '#how', '#globalTop']) {
    assert.ok(HOME.includes(`href="${anchor}"`), `导航锚点 ${anchor} 丢了`);
    // 每个锚点都要有对应的 id，否则又是死链
    assert.ok(HOME.includes(`id="${anchor.slice(1)}"`), `导航指向 ${anchor} 但页面上没有对应 id`);
  }
  assert.ok(HOME.includes('href="/membership/"'), 'Sign in 入口丢了');
});

/* ═══════════ 3 · 大厅功能完整（删的是入口，不是功能） ═══════════ */

test('大厅四种模式全在', () => {
  for (const mode of ['ai', 'daily', 'create', 'join']) {
    assert.ok(LOBBY_HTML.includes(`data-mode="${mode}"`), `大厅缺 ${mode} 模式`);
  }
});

test('大厅分类 / 难度 / 规则 / 战书卡全在', () => {
  for (const id of ['catGrid', 'kbDiff', 'kbRules', 'kbWar', 'kbCreateBtn', 'kbRoomInput']) {
    assert.ok(LOBBY_HTML.includes(`id="${id}"`), `大厅缺 #${id}`);
  }
});

/* ═══════════ 4 · 外围契约不受影响 ═══════════ */

test('7 个下线游戏的 301 仍指向大厅', () => {
  const retired = [
    'color-recall', 'daily-challenge', 'emoji-ghost', 'number-recall',
    'sequence-memory', 'chimp-test', 'word-recall',
  ];
  for (const slug of retired) {
    const line = REDIRECTS.split('\n').find((l) => l.includes(`/games/${slug}*`));
    assert.ok(line, `_redirects 缺 ${slug} 的 301（删首页区块不应动到它）`);
    assert.ok(line.includes('/games/knowledge-duel/lobby/') && /301\s*$/.test(line.trim()),
      `${slug} 的 301 落点或状态码不对：${line}`);
  }
});

test('sitemap 仍收录大厅（首页删区块不改变页面索引）', () => {
  assert.ok(SITEMAP.includes('https://www.memoryduel.com/games/knowledge-duel/lobby/'),
    'sitemap 里大厅 URL 丢了 —— 首页的入口少了，再不收录就真的找不到了');
});

test('首页仍标记 knowledge-duel 为 live（sitemap 脚本靠它判定上线游戏）', () => {
  /* 🔴 2026-11-24 构建门禁抓到的真事故：删掉三模式区块后，首页再没有
     data-stage="live"，scripts/filter-sitemap.mjs 的 live 集合变空，
     生产构建的 dist/sitemap.xml 把 knowledge-duel 整条删掉了，但源
     public/sitemap.xml 看起来完全正常 —— 只有构建日志会报
     「已移除未上线游戏: knowledge-duel」。所以用脚本同款正则锁死。 */
  const live = [...HOME.matchAll(
    /href="\/games\/([a-z0-9-]+)\/(?:lobby\/)?"\s+data-stage="live"/g,
  )].map((m) => m[1]);
  assert.deepEqual(live, ['knowledge-duel'],
    `首页 live 游戏集合不对：${JSON.stringify(live)}。生产 sitemap 会据此删条目`);
});
