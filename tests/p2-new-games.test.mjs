/**
 * P2 三款新游戏前端单测（2026-10-13）
 * ────────────────────────────────────────────────────────────────
 * 覆盖四层契约，任何一层漂移都会导致「线上点了没反应 / 进度条对不上」：
 *   1. 契约层 LEVELS / roundMax / roundLen / resolveMode 的数值与后端一致
 *   2. 每日队列以服务端 today.queue 为准（不再硬编码三关）
 *   3. runLevel 的玩法分发覆盖全部 6 关，且 word-recall 走带 lang 的取题/提交
 *   4. 六语文案齐全 + 侧栏不再写死三关
 *
 * 🔴 为什么必须和 worker 侧对照测：
 *   前端 LEVELS.roundMax 写错时**没有任何报错**，只是成绩页永远不显示
 *   「本轮满分」、进度条关数对不上 —— 属于最难发现的一类漂移。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLIENT_JS = path.join(ROOT, 'public/shared/daily-client.js');
const DAILY_TS = path.join(ROOT, 'src/pages/daily-game.ts');
const LOBBY_TS = path.join(ROOT, 'src/pages/daily-lobby.ts');
const LOBBY_HTML = path.join(ROOT, 'games/daily-challenge/lobby/index.html');
const WORKER_DAILY = 'D:/GAME/tri-sites/worker/src/sites/memoryduel/routes/daily.js';

/* ─── 加载契约层（仿浏览器沙箱，理由同 p1-4-share-card.test.mjs）─── */
function loadClient() {
  const src = fs.readFileSync(CLIENT_JS, 'utf8');
  const sandbox = {
    window: { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
    document: { documentElement: { getAttribute: () => 'en' } },
    fetch: async () => ({ ok: false, status: 500, json: async () => null }),
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    URLSearchParams,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.DailyClient;
}

const c = loadClient();
const dailyTs = fs.readFileSync(DAILY_TS, 'utf8');
const lobbyTs = fs.readFileSync(LOBBY_TS, 'utf8');
const lobbyHtml = fs.readFileSync(LOBBY_HTML, 'utf8');

/* ═══════════ 1. 关卡定义 ═══════════ */
test('LEVELS 恰好 6 关，顺序与后端一致', () => {
  assert.deepStrictEqual(Object.keys(c.LEVELS), [
    'number-recall', 'sequence-memory', 'color-recall',
    'emoji-ghost', 'chimp-test', 'word-recall',
  ]);
});

test('各关满分与后端 maxScoreOf 一致', () => {
  assert.strictEqual(c.LEVELS['number-recall'].maxScore, 12);
  assert.strictEqual(c.LEVELS['sequence-memory'].maxScore, 12);
  assert.strictEqual(c.LEVELS['color-recall'].maxScore, 50);
  assert.strictEqual(c.LEVELS['emoji-ghost'].maxScore, 30);   // 3 轮 × 10
  assert.strictEqual(c.LEVELS['chimp-test'].maxScore, 18);    // 5+6+7
  assert.strictEqual(c.LEVELS['word-recall'].maxScore, 30);   // 6+10+14
});

test('各关轮数正确', () => {
  assert.strictEqual(c.LEVELS['color-recall'].rounds, 1);
  for (const g of ['number-recall', 'sequence-memory', 'emoji-ghost', 'chimp-test', 'word-recall']) {
    assert.strictEqual(c.LEVELS[g].rounds, 3, g);
  }
});

test('每关都有图标（进度条要显示 icon.icon）', () => {
  for (const [g, m] of Object.entries(c.LEVELS)) {
    assert.ok(m.icon && m.icon.length > 0, `${g} 缺 icon`);
  }
});

/* ═══════════ 2. 每轮长度与满分 ═══════════ */
test('roundLen 按各关步进递增（emoji 步进 2 / word 步进 4）', () => {
  assert.deepStrictEqual([1, 2, 3].map((r) => c.roundLen('number-recall', r)), [3, 4, 5]);
  assert.deepStrictEqual([1, 2, 3].map((r) => c.roundLen('emoji-ghost', r)), [4, 6, 8]);
  assert.deepStrictEqual([1, 2, 3].map((r) => c.roundLen('chimp-test', r)), [5, 6, 7]);
  assert.deepStrictEqual([1, 2, 3].map((r) => c.roundLen('word-recall', r)), [6, 10, 14]);
  assert.deepStrictEqual([1, 2, 3].map((r) => c.roundLen('color-recall', r)), [5, 5, 5]);
});

test('roundMax 与后端逐关一致', () => {
  assert.deepStrictEqual([1, 2, 3].map((r) => c.roundMax('number-recall', r)), [3, 4, 5]);
  assert.deepStrictEqual([1, 2, 3].map((r) => c.roundMax('emoji-ghost', r)), [10, 10, 10]);
  assert.deepStrictEqual([1, 2, 3].map((r) => c.roundMax('chimp-test', r)), [5, 6, 7]);
  assert.deepStrictEqual([1, 2, 3].map((r) => c.roundMax('word-recall', r)), [6, 10, 14]);
  assert.strictEqual(c.roundMax('color-recall', 1), 50);
});

test('roundMax 每轮之和等于关卡满分', () => {
  for (const g of Object.keys(c.LEVELS)) {
    const m = c.LEVELS[g];
    let sum = 0;
    for (let r = 1; r <= m.rounds; r++) sum += c.roundMax(g, r);
    assert.strictEqual(sum, m.maxScore, `${g}: ${sum} != ${m.maxScore}`);
  }
});

test('未知关卡 roundMax/roundLen 返回 0 而不是抛异常', () => {
  assert.strictEqual(c.roundMax('nope', 1), 0);
  assert.strictEqual(c.roundLen('nope', 1), 0);
});

/* ═══════════ 3. resolveMode ═══════════ */
test('六个单关 mode 全部可解析且队列长度为 1', () => {
  const want = {
    number: 'number-recall', sequence: 'sequence-memory', color: 'color-recall',
    emoji: 'emoji-ghost', chimp: 'chimp-test', word: 'word-recall',
  };
  for (const [mode, game] of Object.entries(want)) {
    const r = c.resolveMode(mode);
    assert.ok(r, `mode=${mode} 解析失败`);
    assert.strictEqual(r.game, game, `mode=${mode}`);
    // 🔴 用 JSON 比而不是 deepStrictEqual：契约层跑在 vm 沙箱里，
    //    它 new 出来的 Array 与主 realm 的 Array 原型不同，
    //    deepStrictEqual 会因「原型不相等」把内容相同的两个数组判为不等。
    assert.strictEqual(JSON.stringify(r.queue), JSON.stringify([game]), `mode=${mode} 队列应为单关`);
  }
});

test('daily / 空 mode 标记 daily=true（队列交给服务端下发）', () => {
  assert.strictEqual(c.resolveMode('daily').daily, true);
  assert.strictEqual(c.resolveMode(null).daily, true);
  assert.strictEqual(c.resolveMode('').daily, true);
});

test('无效 mode 返回 null（页面据此回大厅）', () => {
  for (const bad of ['nope', 'DAILY_X', '../etc', 'number;alert(1)']) {
    assert.strictEqual(c.resolveMode(bad), null, bad);
  }
});

/* ═══════════ 4. 每日轮换池 ═══════════ */
test('轮换池 5 关，word-recall 不在内（题目按语言分裂）', () => {
  assert.strictEqual(JSON.stringify(c.ROTATION_POOL), JSON.stringify([
    'number-recall', 'sequence-memory', 'color-recall', 'emoji-ghost', 'chimp-test',
  ]));
  assert.ok(!c.ROTATION_POOL.includes('word-recall'));
});

test('轮换池每一关都在 LEVELS 里有定义', () => {
  for (const g of c.ROTATION_POOL) assert.ok(c.LEVELS[g], g);
});

/* ═══════════ 5. 每日队列以服务端为准 ═══════════ */
test('main() 用 today.queue，不再硬编码本地三关', () => {
  assert.ok(dailyTs.includes('today.queue'), '未读取 today.queue');
  assert.ok(dailyTs.includes('Array.isArray(today.queue)'), '未校验 queue 是数组');
});

test('服务端下发未知关卡时显性报错，不让页面在 undefined.icon 上崩', () => {
  assert.ok(dailyTs.includes('unknown'), '缺少未知关卡防护');
  assert.ok(/unknown.*关卡|未知关卡/i.test(dailyTs), '缺少未知关卡提示文案');
});

test('状态队列落库后才画进度条', () => {
  const iAssign = dailyTs.indexOf('state.queue = queue');
  const iRender = dailyTs.indexOf('renderSteps(queue[0])');
  assert.ok(iAssign > 0 && iRender > iAssign, 'queue 必须在 renderSteps 之前赋值');
});

/* ═══════════ 6. 玩法分发覆盖 6 关 ═══════════ */
test('runLevel 分发覆盖全部 6 关', () => {
  for (const [game, fn] of [
    ['number-recall', 'playNumber'],
    ['sequence-memory', 'playSequence'],
    ['color-recall', 'playColor'],
    ['emoji-ghost', 'playEmojiGhost'],
    ['chimp-test', 'playChimp'],
    ['word-recall', 'playWordRecall'],
  ]) {
    assert.ok(
      new RegExp(`game === '${game}'\\)\\s+played = await ${fn}\\(`).test(dailyTs),
      `${game} 未分发到 ${fn}`
    );
  }
});

test('分发有 else 兜底（未知关卡不静默落到最后一关）', () => {
  assert.ok(/else \{ renderError\(`unknown game:/.test(dailyTs),
    '未知关卡会静默落到 playColor');
});

test('三款新玩法函数均已实现', () => {
  for (const fn of ['playEmojiGhost', 'playChimp', 'playWordRecall']) {
    assert.ok(new RegExp(`async function ${fn}\\(`).test(dailyTs), `${fn} 未实现`);
  }
});

test('返回的是玩家实际作答，不是正确答案', () => {
  // emoji：选项下标
  assert.ok(/answer: pick/.test(dailyTs), 'emoji 未回传玩家所选下标');
  // chimp：点击的格子数组
  assert.ok(/return \{ answer: picked \}/.test(dailyTs), 'chimp 未回传点击格子');
  // word：逐词判断数组
  assert.ok(/answer: answers\.map/.test(dailyTs), 'word 未回传逐词判断');
});

/* ═══════════ 7. 语言一致性红线 ═══════════ */
test('word-recall 取题与提交都带 lang', () => {
  assert.ok(dailyTs.includes('fetchPuzzleInLang(game, round, c.fetchAnswerLang())'),
    'word-recall 取题未带 lang');
  assert.ok(dailyTs.includes('submitAnswer(game, round, played.answer, c.fetchAnswerLang())'),
    'word-recall 提交未带 lang');
});

test('非 word-recall 关卡不传 lang（其余语言无关）', () => {
  // 取题
  assert.ok(dailyTs.includes(': (await c.fetchPuzzle(game, round)).puzzle'), '普通取题路径缺失');
  // 提交
  assert.ok(dailyTs.includes(': await c.submitAnswer(game, round, played.answer)'), '普通提交路径缺失');
});

test('契约层提供 fetchAnswerLang 与 fetchPuzzleInLang', () => {
  assert.strictEqual(typeof c.fetchAnswerLang, 'function');
  assert.strictEqual(typeof c.fetchPuzzleInLang, 'function');
});

test('fetchAnswerLang 跟随 html[lang]，非六语回落 en', () => {
  const mk = (lang) => {
    const src = fs.readFileSync(CLIENT_JS, 'utf8');
    const sandbox = {
      window: { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
      document: { documentElement: { getAttribute: () => lang } },
      fetch: async () => ({ ok: false, status: 500, json: async () => null }),
      AbortController, setTimeout, clearTimeout, console, URLSearchParams,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox.window.DailyClient.fetchAnswerLang();
  };
  assert.strictEqual(mk('zh'), 'zh');
  assert.strictEqual(mk('JA'), 'ja');
  assert.strictEqual(mk('pt'), 'en');
  assert.strictEqual(mk(null), 'en');
});

/* ═══════════ 8. 大厅页 ═══════════ */
test('大厅侧栏不再静态写死三关（每日已改轮换）', () => {
  const seg = lobbyHtml.slice(lobbyHtml.indexOf('id="lvRows"'), lobbyHtml.indexOf('id="lvRows"') + 200);
  assert.ok(!seg.includes('dc-side-row'), 'lvRows 里仍有静态行，会与今日实际队列不符');
});

test('大厅侧栏关卡名取自 LEVELS + i18n，不硬编码', () => {
  assert.ok(!/l\.game === 'number-recall' \? '🔢'/.test(lobbyTs), '仍有硬编码图标');
  assert.ok(lobbyTs.includes('c.LEVELS[l.game]'), '未从 LEVELS 取图标');
  assert.ok(lobbyTs.includes('t(`dc.${l.game}`'), '未用 i18n 取关卡名');
});

test('大厅 mode 合法性交给 resolveMode，不重抄列表', () => {
  assert.ok(!/const valid = \[/.test(lobbyTs), '仍有硬编码 valid 列表');
  assert.ok(lobbyTs.includes('resolveMode(mode)'), '未调用 resolveMode 判定');
});

test('大厅三张新卡片都存在且指向正确 mode', () => {
  for (const m of ['emoji', 'chimp', 'word']) {
    assert.ok(lobbyHtml.includes(`?mode=${m}`), `缺 mode=${m} 卡片`);
    assert.ok(lobbyHtml.includes(`data-mode="${m}"`), `缺 data-mode="${m}"`);
  }
});

/* ═══════════ 9. 六语文案齐全 ═══════════ */

/* 🔴 2026-10-13 必须用**运行时同款取值方式**。
   运行时 i18n.js 的 get() 按 '.' 分层走：'dc.emoji-ghost' → d.dc['emoji-ghost']。
   原断言写的是 d['dc.emoji-ghost'] —— 那是顶层扁平键，
   于是 add-p2-games-i18n.py 把 28 个键写到顶层时测试照样全绿，
   而真实页面取不到值、i18n.t() 回退成返回 key 本身，
   页面上直接显示「👻 emoji-ghost 30」「Emoji Ghost」，且零报错。
   这是「测试假绿 → 线上暴露」的典型案例：断言方式与被测代码的取值方式不一致。 */
function i18nGet(dict, key) {
  let cur = dict;
  for (const part of String(key).split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

test('六关名在六语下都齐全（进度条不得退回显示游戏 id）', () => {
  /* 🔴 回归防线：老三关的 dc.<game-id> 键曾**一直缺失**（字典里它们叫
     numduel.* / seqduel.* / colduel.*），而 renderSteps 用的正是 dc.${g}，
     于是进度条永远显示「number-recall」而不是「数字广度」，
     且**零报错**——i18n.t 缺键时返回 key 本身，被 fallback 原样显示。 */
  const games = Object.keys(c.LEVELS);
  for (const lang of ['en', 'zh', 'ja', 'es', 'fr', 'de']) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, `public/i18n/${lang}.json`), 'utf8'));
    for (const g of games) {
      const key = `dc.${g}`;
      const v = i18nGet(d, key);
      assert.ok(typeof v === 'string' && v.length > 0, `${lang} 缺 ${key}（嵌套取值）`);
      assert.notStrictEqual(v, g, `${lang} 的 ${key} 不能等于游戏 id（等于没翻译）`);
    }
  }
});

test('六语 25 个新键齐全（缺一语会把 key 本身显示给用户）', () => {
  const keys = [
    'dc.emoji-ghost', 'dc.chimp-test', 'dc.word-recall',
    'dc.emoji_h2', 'dc.emoji_help', 'dc.emoji_ready', 'dc.emoji_pick',
    'dc.chimp_h2', 'dc.chimp_help', 'dc.chimp_ready', 'dc.chimp_pick', 'dc.chimp_done',
    'dc.word_h2', 'dc.word_help', 'dc.word_ready', 'dc.word_pick',
    'dc.word_new', 'dc.word_seen', 'dc.word_lock',
    'dc.lobby_mt_emoji', 'dc.lobby_md_emoji',
    'dc.lobby_mt_chimp', 'dc.lobby_md_chimp',
    'dc.lobby_mt_word', 'dc.lobby_md_word',
  ];
  for (const lang of ['en', 'zh', 'ja', 'es', 'fr', 'de']) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, `public/i18n/${lang}.json`), 'utf8'));
    for (const k of keys) {
      const v = i18nGet(d, k);
      assert.ok(typeof v === 'string' && v.length > 0, `${lang} 缺 ${k}（嵌套取值）`);
      assert.notStrictEqual(v, k, `${lang} 的 ${k} 取值等于 key 本身（等于没翻译）`);
    }
  }
});

test('六语字典顶层不得残留 dc.* 扁平键（写错命名空间 = 运行时取不到）', () => {
  /* 🔴 回归防线：写入脚本若用 d['dc.xxx']=v 会生成顶层扁平键，
     运行时永远取不到，且因为测试也用扁平取值而长期假绿。 */
  for (const lang of ['en', 'zh', 'ja', 'es', 'fr', 'de']) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, `public/i18n/${lang}.json`), 'utf8'));
    const flat = Object.keys(d).filter((k) => k.startsWith('dc.'));
    assert.strictEqual(flat.length, 0, `${lang} 顶层残留 dc.* 扁平键：${flat.slice(0, 5).join(', ')}`);
  }
});

test('六语 dictVersion 一致且与 VERSION 文件相符', () => {
  const ver = fs.readFileSync(path.join(ROOT, 'public/i18n/VERSION'), 'utf8').trim();
  const htmls = ['index.html', 'games/daily-challenge/index.html', 'games/daily-challenge/lobby/index.html'];
  for (const h of htmls) {
    const s = fs.readFileSync(path.join(ROOT, h), 'utf8');
    assert.ok(s.includes(`dictVersion:${ver}`), `${h} 的 dictVersion 与 VERSION 不符`);
  }
});

/* ═══════════ 10. 与后端源码的交叉校验 ═══════════ */
test('后端轮换池与前端 ROTATION_POOL 一致', () => {
  if (!fs.existsSync(WORKER_DAILY)) return;   // worker 仓库不在本机时跳过
  const s = fs.readFileSync(WORKER_DAILY, 'utf8');
  const m = s.match(/ROTATION_POOL\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, '未找到后端 ROTATION_POOL');
  const list = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.strictEqual(JSON.stringify(list), JSON.stringify(c.ROTATION_POOL), '前后端轮换池不一致');
});

test('后端 roundLen 的 step 与前端 LEVELS.step 一致', () => {
  if (!fs.existsSync(WORKER_DAILY)) return;
  const s = fs.readFileSync(WORKER_DAILY, 'utf8');
  // roundLen 里写的是三元表达式而非查表，这里只锁 emoji/word 两个特殊步进
  assert.ok(/emoji-ghost' \? 2/.test(s), '后端 emoji 步进不再是 2');
  assert.ok(/word-recall' \? 4/.test(s), '后端 word 步进不再是 4');
  assert.strictEqual(c.roundLen('emoji-ghost', 2), 6);
  assert.strictEqual(c.roundLen('word-recall', 3), 14);
});