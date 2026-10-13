/**
 * P1-4 分享卡单测
 * ────────────────────────────────────────────────────────────────
 * 覆盖三件事：
 *  1. 引擎：card.icon / gameName / metaLines 覆盖生效，且 numeri 存量路径逐字不变
 *  2. 一致性：toSVG 与 renderCard 取同一套映射（防「PNG 和 SVG 显示不同游戏名」）
 *  3. 降级：daily-game.ts 在引擎缺失 / Canvas 不可用时确实降级，而不是崩掉
 *
 * 🔴 为什么要用 vm 加载而不是 require：
 *   memoryduel-web/package.json 声明了 "type": "module"，ESM 里 `module` 未定义，
 *   所以 share-card.js 里那段 `if (typeof module !== 'undefined') module.exports = ...`
 *   是**死代码**，require() 拿到的是空对象。这是真实存在的导出路径失效问题，
 *   浏览器侧靠 window.ShareCard 正常工作，但 Node 侧测不到。
 *   这里用 vm 造一个带 window 的沙箱，模拟浏览器全局，验证的正是线上真正跑的那条路径。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHARE_CARD = path.join(ROOT, 'public/shared/share-card.js');
const DAILY_TS = path.join(ROOT, 'src/pages/daily-game.ts');

/* ═══════════════════════════════════════════════════════════════
   工具：把 IIFE 脚本塞进一个仿浏览器的 vm 沙箱
   ═══════════════════════════════════════════════════════════════ */
function loadAsBrowser(srcPath = SHARE_CARD) {
  const src = fs.readFileSync(srcPath, 'utf8');
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: srcPath });
  return sandbox.ShareCard;
}

/* ═══════════════════════════════════════════════════════════════
   1. 引擎层
   ═══════════════════════════════════════════════════════════════ */

test('引擎在仿浏览器沙箱中挂载到 window.ShareCard', () => {
  const SC = loadAsBrowser();
  assert.ok(SC, 'window.ShareCard 必须存在');
  for (const fn of ['renderCard', 'downloadCard', 'toDataURL', 'copyToClipboard', 'toSVG']) {
    assert.equal(typeof SC[fn], 'function', `ShareCard.${fn} 应为函数`);
  }
});

test('card.icon / gameName 覆盖内置表（memoryduel 每日挑战用法）', () => {
  const SC = loadAsBrowser();
  const svg = SC.toSVG({
    game: 'daily-challenge', icon: '🧠', gameName: '每日挑战',
    title: '32 / 74', subtitle: 'x', metaLines: ['🔥 3 连', '⭐ 32 分'],
  }, 'memory');
  assert.ok(svg.includes('🧠'), '应显示自定义图标');
  assert.ok(svg.includes('每日挑战'), '应显示自定义游戏名');
  assert.ok(svg.includes('🔥 3 连') && svg.includes('⭐ 32 分'), '应显示 metaLines');
});

test('numeri 存量路径逐字不变（24 点 / 金字塔 / 数独）', () => {
  const SC = loadAsBrowser();
  const cases = [
    ['24-game', '🃏', '24 点'],
    ['pyramid', '🔺', '金字塔'],
    ['sudoku', '🔢', '数独'],
  ];
  for (const [game, icon, name] of cases) {
    const svg = SC.toSVG({ game, title: 'A', subtitle: 'B' }, 'math');
    assert.ok(svg.includes(icon), `${game} 图标应为 ${icon}`);
    assert.ok(svg.includes(name), `${game} 名称应为 ${name}`);
  }
});

test('numeri meta 字段集自动成行，顺序与旧实现一致', () => {
  const SC = loadAsBrowser();
  const svg = SC.toSVG({
    game: '24-game', title: 'A',
    meta: { duration: 95, solutions_count: 1, streak: 3, score: 120, attempts: 2 },
  }, 'math');
  // 🔴 顺序即旧实现的 push 顺序：⏱ → 💡 → 🔥 → ⭐ → 🎯
  for (const s of ['💡 1 解', '🔥 3 连', '⭐ 120 分', '🎯 2 次']) {
    assert.ok(svg.includes(s), `应包含 ${s}`);
  }
  const i3 = svg.indexOf('🔥 3 连');
  const i4 = svg.indexOf('⭐ 120 分');
  assert.ok(i3 < i4, '🔥 应排在 ⭐ 之前');
});

test('metaLines 优先于 meta，且最多 4 行', () => {
  const SC = loadAsBrowser();
  const svg = SC.toSVG({
    game: '24-game', title: 'A',
    meta: { streak: 3, score: 120 },
    metaLines: ['💯 2/3 关满分', '📅 2026-10-13'],
  }, 'math');
  assert.ok(svg.includes('💯 2/3 关满分'), '应显示 metaLines');
  assert.ok(!svg.includes('🔥 3 连'), 'metaLines 存在时 meta 应被忽略');

  const many = SC.toSVG({
    game: '24-game', title: 'A',
    metaLines: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'],
  }, 'math');
  assert.ok(many.includes('L4') && !many.includes('L5'), 'metaLines 应截断到 4 行');
});

test('metaLines 里的空串被丢弃，不会留下空行', () => {
  const SC = loadAsBrowser();
  const svg = SC.toSVG({
    game: '24-game', title: 'A',
    metaLines: ['A', '', '  ', null, 'B'],
  }, 'math');
  assert.ok(svg.includes('A') && svg.includes('B'));
  assert.ok(!svg.includes('undefined'), 'null 不应变成字符串 "undefined"');
});

test('未知游戏回落 🎮，不吞掉调用方给的 game 名', () => {
  const SC = loadAsBrowser();
  const svg = SC.toSVG({ game: 'brand-new-game', title: 'A' }, 'memory');
  assert.ok(svg.includes('🎮'), '未知游戏应回落 🎮');
  assert.ok(svg.includes('brand-new-game'), '未知游戏名应原样显示');
});

test('空 meta 不渲染残留分隔符', () => {
  const SC = loadAsBrowser();
  const svg = SC.toSVG({ game: '24-game', title: 'A', meta: {} }, 'math');
  assert.ok(!svg.includes('·  ·'), '空 meta 不应留下空分隔符');
});

test('三站品牌各自正确', () => {
  const SC = loadAsBrowser();
  assert.ok(SC.toSVG({ game: 'x', title: 'A' }, 'math').includes('numeriduel.com'));
  assert.ok(SC.toSVG({ game: 'x', title: 'A' }, 'board').includes('boardduel.com'));
  assert.ok(SC.toSVG({ game: 'x', title: 'A' }, 'memory').includes('memoryduel.com'));
  // 品牌色与 tokens.css --brand-600 对齐
  assert.ok(SC.toSVG({ game: 'x', title: 'A' }, 'math').includes('#4F46E5'));
  assert.ok(SC.toSVG({ game: 'x', title: 'A' }, 'board').includes('#7F77DD'));
  assert.ok(SC.toSVG({ game: 'x', title: 'A' }, 'memory').includes('#EA580C'));
});

/* ═══════════════════════════════════════════════════════════════
   2. 双渲染路径一致性（本次改造的核心动机）
   ═══════════════════════════════════════════════════════════════ */

test('toSVG 与 renderCard 读同一套映射表，不各自漂移', () => {
  const SC = loadAsBrowser();
  const src = fs.readFileSync(SHARE_CARD, 'utf8');

  // 图标/名称表与 meta 行规则在文件里各只应出现一份定义
  const iconTableDefs = (src.match(/const GAME_ICONS\s*=/g) || []).length;
  const nameTableDefs = (src.match(/const GAME_NAMES\s*=/g) || []).length;
  const metaFnDefs = (src.match(/function metaLinesOf\s*\(/g) || []).length;
  assert.equal(iconTableDefs, 1, 'GAME_ICONS 只能定义一次');
  assert.equal(nameTableDefs, 1, 'GAME_NAMES 只能定义一次');
  assert.equal(metaFnDefs, 1, 'metaLinesOf 只能定义一次');

  // 🔴 反向断言：抓「又内联了一份表」的各种写法。
  //   键名可能带引号也可能不带（'24-game': 或 24-game:），表变量名也任意，
  //   所以不写死具体标识符，只认「字面量表 + 🃏 这个特征值」同现即算一份表。
  //   判据是**整个文件里只能有一份**（模块作用域那唯一合法的那份），
  //   而不是零份 —— 引擎总得有地方存这些名字。
  const dupTable = /\{[^{}]*['"]?24-game['"]?\s*:\s*['"][^'"]*🃏[^'"]*['"][^{}]*\}/g;
  const iconTables = src.match(dupTable) || [];
  assert.equal(iconTables.length, 1,
    `GAME_ICONS 字面量表应恰好存在 1 份，实得 ${iconTables.length} 份（多份即两条渲染路径各自内联）`);

  const dupName = /\{[^{}]*['"]?24-game['"]?\s*:\s*['"][^'"]*24\s*点[^'"]*['"][^{}]*\}/g;
  const nameTables = src.match(dupName) || [];
  assert.equal(nameTables.length, 1,
    `GAME_NAMES 字面量表应恰好存在 1 份，实得 ${nameTables.length} 份`);

  // 这唯一一份必须位于模块作用域（GAME_ICONS/GAME_NAMES 定义处），
  // 且 renderCard / toSVG 各自的函数体内都不许再出现特征值。
  const renderBody = src.slice(src.indexOf('function renderCard'), src.indexOf('function downloadCard'));
  const svgBody = src.slice(src.indexOf('function toSVG'));
  assert.ok(!renderBody.includes('🃏'), 'renderCard 内不应再内联游戏图标字面量');
  assert.ok(!svgBody.includes('🃏'), 'toSVG 内不应再内联游戏图标字面量');
  assert.ok(!renderBody.includes('24 点'), 'renderCard 内不应再内联游戏名字面量');
  assert.ok(!svgBody.includes('24 点'), 'toSVG 内不应再内联游戏名字面量');
});

/* ═══════════════════════════════════════════════════════════════
   3. 接入层：daily-game.ts 的降级路径
   ═══════════════════════════════════════════════════════════════ */

const dailySrc = fs.readFileSync(DAILY_TS, 'utf8');

test('每日挑战页加载了分享卡引擎', () => {
  const html = fs.readFileSync(path.join(ROOT, 'games/daily-challenge/index.html'), 'utf8');
  assert.ok(/<script src="\/shared\/share-card\.js[^"]*"><\/script>/.test(html),
    '页面必须引入 /shared/share-card.js');
  // 顺序很重要：普通 script 先于 type=module，模块执行时才拿得到 window.ShareCard
  const plainIdx = html.indexOf('/shared/share-card.js');
  const modIdx = html.indexOf('src="/src/pages/daily-game.ts"');
  assert.ok(plainIdx > -1 && modIdx > -1 && plainIdx < modIdx,
    'share-card.js 必须排在 daily-game.ts 之前');
});

test('引擎缺失时降级为文本摘要，而不是抛错', () => {
  assert.ok(/const cv = renderShareCanvas\(card\);\s*\n\s*if \(!sc \|\| !cv\)/.test(dailySrc),
    '必须同时判 sc 与 cv，任一缺失都走文本降级');
  assert.ok(/dc-share-text/.test(dailySrc), '降级路径要有可复制的文本区');
});

/* 🔴 这条是 2026-10-13 L3 真机验收抓出来的产品 bug，锁死防止回归：
 *
 * 降级分支里写的是
 *     box.innerHTML = '<textarea id="shareText">…';
 *     const ta = document.getElementById('shareText');   // ← 此时 box 还没进 DOM
 *     if (ta) ta.value = shareFallbackText(card);
 *     host.appendChild(box);
 *
 * getElementById 只在 document 上查，box 此刻是游离节点 → ta 恒为 null →
 * 赋值被静默跳过 → 玩家看到的是一个**空白**文本框，复制不到任何成绩。
 *
 * 为什么单测测不出来：这条分支只在引擎缺失 / Canvas 不可用时才走，
 * 正常路径永远碰不到。必须先 appendChild 再取值。 */
test('降级文本区必须先挂载再赋值（空白文本框回归防护）', () => {
  const s = dailySrc.slice(dailySrc.indexOf('function mountShare'));
  const body = s.slice(0, s.indexOf('\nfunction bindNativeShare'));

  const textIdx = body.indexOf('dc-share-text');
  const getIdx = body.indexOf("getElementById('shareText')");
  const appendIdx = body.indexOf('host.appendChild(box)');

  assert.ok(textIdx > -1 && getIdx > -1 && appendIdx > -1, '降级分支应包含文本框、取值与挂载三步');
  assert.ok(appendIdx < getIdx,
    `host.appendChild(box) 必须早于 getElementById('shareText')（实际 append@${appendIdx} vs get@${getIdx}）`);

  // 赋值必须在取值之后 —— 这才是「空白文本框」的唯一成因。
  // 允许保留 if (ta) 这类 null guard：它防的是 DOM 被别处搬走，
  // 与「先查后挂载导致恒为 null」是两回事，硬禁反而会把安全检查判成缺陷。
  const assignIdx = body.indexOf('ta.value = shareFallbackText(card)');
  assert.ok(assignIdx > getIdx, '赋值必须在查到元素之后');

  // 但如果真的取不到元素，必须留痕，不能静默走人 —— 否则空白框又会变成
  // 「看起来正常但没有内容」的无声故障。
  const hasGuard = /if \(ta\)/.test(body);
  assert.ok(!hasGuard || /ta\)\s*\{?[\s\S]{0,160}?(console\.(warn|error))/.test(body),
    '保留了 if (ta) 守卫时，取不到元素必须 console 留痕，不能静默跳过');
});

test('Canvas 上下文不可用时先探测再交给引擎', () => {
  // 🔴 关键：getContext('2d') 返回 null 时，引擎内 ctx.fillStyle=... 会抛
  //    TypeError。所以必须在调用 renderCard 之前探测。
  const probeIdx = dailySrc.indexOf("if (!cv.getContext('2d')) return null;");
  const callIdx = dailySrc.indexOf('sc.renderCard(cv, card,');
  assert.ok(probeIdx > -1, 'renderShareCanvas 必须探测 2d 上下文');
  assert.ok(probeIdx < callIdx, '探测必须发生在 renderCard 之前');
  assert.ok(renderShareCanvasIsWrapped(), 'renderShareCanvas 整体要用 try/catch 包住');
});

function renderShareCanvasIsWrapped() {
  const s = dailySrc.slice(dailySrc.indexOf('function renderShareCanvas'));
  const body = s.slice(0, s.indexOf('\n}'));
  return /try\s*{/.test(body) && /catch\s*\(\s*_\s*\)/.test(body);
}

test('分享区挂载失败不影响成绩展示与「再来一次」', () => {
  const s = dailySrc.slice(dailySrc.indexOf('async function showFinal'));
  const mountIdx = s.indexOf('mountShare(card, buildShareCard())');
  const againIdx = s.indexOf("document.getElementById('againBtn')");
  assert.ok(mountIdx > -1, '终局页必须挂载分享区');
  assert.ok(s.includes('try {'), '挂载必须包在 try 里');
  assert.ok(mountIdx < againIdx, '分享区挂在按钮绑定之前，但不能阻断它');
  // mountShare 之前的 innerHTML 已经写好了成绩，放后面不影响
  assert.ok(s.indexOf('dc-result-score') < mountIdx, '成绩先渲染，分享后挂载');
});

test('复制动作对图片失败有文本兜底', () => {
  assert.ok(/copyToClipboard[\s\S]*?catch[\s\S]*?copyTextFallback/.test(dailySrc),
    '剪贴板写图片失败后必须退到文本复制');
  assert.ok(/function copyTextFallback/.test(dailySrc), '必须有文本复制实现');
  assert.ok(/execCommand\('copy'\)/.test(dailySrc), '非 HTTPS 环境需要 execCommand 兜底');
});

test('分享链接不含答案，也不本地拼日期', () => {
  // 🔴 红线：日期串只能来自服务端 today.date
  assert.ok(/if \(state\.date\)/.test(dailySrc), '日期行应由服务端日期驱动');
  assert.ok(!/toISOString\(\)|Date\.now\(\).*slice.*date/i.test(dailySrc),
    '不得用本地时间构造日期串（会与服务端差一天）');
});

test('下载文件名含服务端日期，便于按日归档', () => {
  assert.ok(/memoryduel-daily-\$\{state\.date \|\| 'today'\}\.png/.test(dailySrc),
    '文件名应带 state.date');
});

/* ═══════════════════════════════════════════════════════════════
   4. i18n：六语文案齐备
   ═══════════════════════════════════════════════════════════════ */

const SHARE_KEYS = [
  'share_hint', 'share_download', 'share_native',
  'share_alt', 'share_cta', 'share_failed',
];
const LANGS = ['en', 'zh', 'ja', 'es', 'fr', 'de'];

test('六语字典都补齐分享文案', () => {
  for (const lg of LANGS) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, `public/i18n/${lg}.json`), 'utf8'));
    for (const k of SHARE_KEYS) {
      const v = d.dc && d.dc[k];
      assert.ok(typeof v === 'string' && v.trim().length > 0,
        `${lg}.dc.${k} 缺失或为空`);
    }
  }
});

test('各语言 dc 命名空间 key 集完全一致（防某语言漏翻）', () => {
  const ref = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n/en.json'), 'utf8'));
  const refKeys = Object.keys(ref.dc).sort();
  for (const lg of LANGS.filter((x) => x !== 'en')) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, `public/i18n/${lg}.json`), 'utf8'));
    assert.deepEqual(Object.keys(d.dc).sort(), refKeys, `${lg} 的 dc key 集与 en 不一致`);
  }
});

test('全站 dictVersion 统一，避免字典缓存碎片', () => {
  const seen = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.html')) continue;
      const m = fs.readFileSync(p, 'utf8').match(/dictVersion:(\d+)/);
      if (!m) continue;
      const list = seen.get(m[1]) || [];
      list.push(path.relative(ROOT, p).replace(/\\/g, '/'));
      seen.set(m[1], list);
    }
  };
  walk(ROOT);
  const versions = [...seen.keys()];
  assert.equal(versions.length, 1,
    `dictVersion 出现 ${versions.length} 个版本 ${JSON.stringify(Object.fromEntries(seen))}`);

  // 🔴 「全站统一」只保证一致，不保证是最新的 —— 只改 JSON 忘了升版，
  // 老用户会继续命中旧缓存拿不到新文案，且没有任何测试会红。
  // 单一真相源改为独立清单文件，改字典时必须同步升它。
  const MANIFEST = path.join(ROOT, 'public', 'i18n', 'VERSION');
  assert.ok(fs.existsSync(MANIFEST), '缺少 public/i18n/VERSION（dictVersion 真相源）');
  const want = fs.readFileSync(MANIFEST, 'utf8').trim();
  assert.equal(versions[0], want,
    `dictVersion=${versions[0]} 与 public/i18n/VERSION=${want} 不一致 —— 改了字典必须升版并同步 VERSION`);
});

test('share-card.d.ts 是类型声明而非运行时模块', () => {
  // 🔴 Vite 会把 .ts 当模块处理；d.ts 只能被 import type 引用
  const dts = fs.readFileSync(path.join(ROOT, 'src/shared/share-card.d.ts'), 'utf8');
  assert.ok(dts.includes('declare global'), '必须是全局声明');
  assert.ok(dts.includes('ShareCardInput'), '应声明输入契约');
  assert.ok(
    /import type \{\} from '\.\.\/shared\/share-card'/.test(dailySrc),
    'daily-game.ts 必须用 import type 引入',
  );
  // 🔴 反向断言要排除 `import type` 前缀，否则会把正确写法也判成值导入：
  //    值导入的形态是 `import x from`（x 非空且 type 不在关键字位置）。
  const valueImports = dailySrc.split('\n').filter((l) =>
    /^\s*import\s+(?!type\b)[^;]*from\s+['"][^'"]*share-card['"]/.test(l));
  assert.deepEqual(valueImports, [], `不得用值导入（会触发运行时解析）: ${valueImports.join(' | ')}`);
});

test('pathToFileURL 被引用（审计器需识别动态 import 测试）', () => {
  assert.ok(pathToFileURL, '确保 node:url 已引入');
});
/* ═══════════════════════════════════════════════════════════════
   单关模式（?mode=number/sequence/color）不得混用三关范围
   ────────────────────────────────────────────────────────────────
   🔴 2026-10-13 页面核查实测：单关模式下顶栏进度条、终局成绩行、
      分享卡满分全部按 GAME_ORDER（三关）渲染 —— 玩家只玩一关却看到
      另外两关 0/12 与「of 74」，会以为成绩被算错。
      根因：renderSteps / showFinal / buildShareCard 无条件取 GAME_ORDER。
   ═══════════════════════════════════════════════════════════════ */
test('进度条 / 终局 / 分享卡的范围都必须跟随本局 queue，不得写死 GAME_ORDER', () => {
  const src = fs.readFileSync(DAILY_TS, 'utf8');

  // 1) renderSteps：必须按 state.queue 取关卡，回落 GAME_ORDER 只能是 queue 为空时
  const stepsFn = src.slice(src.indexOf('function renderSteps'));
  assert.ok(/state\.queue/.test(stepsFn.slice(0, 1200)),
    'renderSteps 必须按 state.queue 渲染（单关模式只能画 1 个 step）');
  assert.ok(!/host\.innerHTML\s*=\s*c\.GAME_ORDER\.map/.test(stepsFn.slice(0, 1200)),
    'renderSteps 不得无条件 map GAME_ORDER');

  // 2) 入口处必须先落 queue 再画进度条（顺序反了首帧仍会画出三关）
  const entryIdx = src.indexOf('state.queue = mode.queue.slice()');
  assert.ok(entryIdx > 0, '入口处必须把 mode.queue 落进 state.queue');
  const afterEntry = src.slice(entryIdx);
  assert.ok(/renderSteps\(mode\.game\)/.test(afterEntry.slice(0, 200)),
    'state.queue 赋值之后才调用 renderSteps');

  // 3) 终局成绩行与满分：不得再用 GAME_ORDER
  const finalFn = src.slice(src.indexOf('async function showFinal'));
  const finalHead = finalFn.slice(0, 2200);
  assert.ok(/const rows = games\.map/.test(finalHead),
    '终局成绩行必须按 games（= state.queue）渲染，不得无条件 GAME_ORDER');
  assert.ok(/const max = games\.reduce/.test(finalHead),
    '终局满分必须按 games 计算（单关模式应为 12/12/50，不是 74）');
  assert.ok(!/const rows = c\.GAME_ORDER\.map/.test(finalHead),
    '终局成绩行不得写死 GAME_ORDER');
  assert.ok(!/const max = c\.GAME_ORDER\.reduce/.test(finalHead),
    '终局满分不得写死 GAME_ORDER');

  // 4) 分享卡：同样不得按三关算满分
  const shareFn = src.slice(src.indexOf('function buildShareCard'));
  const shareHead = shareFn.slice(0, 1600);
  assert.ok(!/const max = c\.GAME_ORDER\.reduce/.test(shareHead),
    '分享卡满分不得写死 GAME_ORDER（否则单关模式会写出「x / 74」）');
  assert.ok(!/c\.GAME_ORDER\.filter\(\(g\) => \(state\.totals/.test(shareHead),
    '分享卡满分关数统计不得写死 GAME_ORDER');

  // 5) 单关终局标题/满分文案必须分流
  assert.ok(/final_title_single/.test(src), '单关终局应有专属标题键 dc.final_title_single');
  assert.ok(/final_perfect_single/.test(src), '单关满分应有专属文案键 dc.final_perfect_single');

  // 6) 六语都必须有这两个键（少一个页面会直接显示 key 原文）
  for (const lg of ['en', 'zh', 'ja', 'es', 'fr', 'de']) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n', lg + '.json'), 'utf8'));
    for (const k of ['final_title_single', 'final_perfect_single']) {
      assert.ok(typeof d.dc?.[k] === 'string' && d.dc[k].trim(),
        `${lg} 缺 dc.${k}`);
    }
  }
});
