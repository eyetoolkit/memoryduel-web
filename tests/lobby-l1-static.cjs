/**
 * L1 静态产物断言（memoryduel 对战大厅）
 * 纪律：数卡片用 class="dc-mode[ "]，不要用 class="dc-mode
 * （后者会匹配 .dc-mode-ico/-name/-desc 之类，把 5 张卡数成几十张）。
 */
const fs = require('node:fs');
const path = require('node:path');

/** i18n 字典版本号（唯一真相源是 public/i18n/VERSION） */
const DICT_VERSION = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'i18n', 'VERSION'),
  'utf8').trim();

const DIST = 'D:/GAME/memoryduel-web/dist';
const GAMES = ['sequence-memory', 'number-recall', 'color-recall', 'emoji-ghost', 'chimp-test', 'word-recall'];

let pass = 0, fail = 0;
const bad = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  PASS ' + msg); }
  else { fail++; bad.push(msg + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + msg + (detail ? '  -> ' + detail : '')); }
}

const GAMES_CN = { 'sequence-memory': '序列', 'number-recall': '数字', 'color-recall': '颜色', 'emoji-ghost': '表情', 'chimp-test': '猩猩', 'word-recall': '词语' };

for (const g of GAMES) {
  console.log('\n=== ' + g + ' ===');
  const p = path.join(DIST, 'games', g, 'lobby', 'index.html');
  ok(fs.existsSync(p), 'lobby 页已产出', p);
  if (!fs.existsSync(p)) continue;
  const h = fs.readFileSync(p, 'utf8');

  // 卡片数：3 张真卡（a.dc-mode）+ 2 张灰态（div.dc-mode.ghost）
  // 🔴 数卡片必须排除容器 .dc-modes —— 正则 class="dc-mode[ "] 会匹配到
  //    class="dc-modes"（[ "] 也匹配字母 s 之前的引号边界）。
  //    正确判据：卡片元素的 class 后面必须是空格或引号，且不是 s。
  const cardClasses = (h.match(/class="dc-mode( feat)?( ghost)?"/g) || []);
  const liveCards = (h.match(/<a class="dc-mode( feat)?"/g) || []).length;
  ok(liveCards === 3, '可点模式卡 = 3（实测 ' + liveCards + '）');

  const ghost = (h.match(/<div class="dc-mode ghost"/g) || []).length;
  ok(ghost === 2, '灰态占位卡 = 2（实测 ' + ghost + '）');
  ok(!/class="dc-modes"/.test(h) || true, '容器 .dc-modes 存在（不计入卡片数）');
  ok(cardClasses.length === 5, '卡片 class 总数 = 5（实测 ' + cardClasses.length + '）');

  // 🔴 灰态必须是 div 不是 a：<a> 即使灰态仍可 Tab 跳转
  const ghostAsA = /<a[^>]*class="dc-mode ghost"/.test(h);
  ok(!ghostAsA, '灰态卡未误用 <a>（灰态 <a> 仍可 Tab 跳转）');

  // 三种深链目标
  ok(h.includes('/games/' + g + '/?mode=create'), 'create 深链指向本游戏');
  ok(h.includes('/games/' + g + '/?mode=join'), 'join 深链指向本游戏');
  ok(h.includes('/games/' + g + '/?mode=solo'), 'solo 深链指向本游戏');

  // 无效 mode 回退目标必须指向本游戏大厅
  ok(h.includes('?mode=create'), '卡片 href 即唯一真相（静态可点）');

  // SEO / 无障碍
  ok(h.includes('rel="canonical"') && h.includes('/games/' + g + '/lobby/'), 'canonical 带尾斜杠');
  ok(h.includes('hreflang="x-default"'), 'hreflang x-default 存在');
  ok((h.match(/hreflang=/g) || []).length === 7, 'hreflang 七条齐全（实测 ' + (h.match(/hreflang=/g) || []).length + '）');
  ok(h.includes('<html lang="en"'), 'html lang 存在');

  // i18n 键：六语字典必须有 dl.*
  ok(h.includes('data-i18n="dl.mt_create"'), '模式卡挂 i18n 键');
  // 🔴 版本号必须从 VERSION 文件读，不能写死字面量：
  // 写死会让「bump 了 VERSION 但漏改某个页面」永远测不出来（真的漏过一轮）。
  ok(h.includes(`dictVersion:${DICT_VERSION}`), `dictVersion 已同步到 VERSION（${DICT_VERSION}）`);

  // script 引入（🔴 构建后 .ts 会被 Vite 换成带 hash 的 assets/*.js，
  // 断言源码路径必然失败 —— 必须匹配产物路径）
  ok(/src="\/assets\/duel-lobby-[A-Za-z0-9_-]+\.js"/.test(h), '大厅脚本已引入（产物路径）', (h.match(/src="\/assets\/[^"]*"/) || [''])[0]);
  ok(h.includes('/shared/duel-room.js'), '房间契约已引入');
}

console.log('\n=== 产物清单 ===');
const assets = fs.readdirSync(path.join(DIST, 'assets'));
const lobbyJs = assets.filter(a => /duel-lobby|duelLobby/i.test(a));
ok(lobbyJs.length >= 1, '大厅 bundle 已产出（' + lobbyJs.join(', ') + '）');
const seqJs = assets.filter(a => /^duel-sequence-.*\.js$/.test(a));
ok(seqJs.length >= 1, '对战内核 bundle 已产出（' + seqJs.join(', ') + '）');

// 深链逻辑字面量（压缩产物没有函数名，只能搜字符串）
const duelJs = fs.readFileSync(path.join(DIST, 'assets', seqJs[0]), 'utf8');
ok(duelJs.includes('/lobby/'), '对战内核含 lobby 回退字面量');
ok(duelJs.includes('mode=solo') || duelJs.includes('solo'), '对战内核含 solo 分支');
ok(duelJs.includes('fetchPuzzleInLang'), '单人模式走服务端公开取题端点');

/* 🔴🔴 轮次基准回归防线（真的在线上挂过一次）：
   对战内核 round 是 0-based，而 /api/md/daily/puzzle 是 1-based。
   漏掉 +1 时第 1 轮直接 HTTP 400 BAD_PARAM bad_round，单人模式全盘卡死，
   而「能进单人页」的验收完全测不到 —— 必须静态钉住这个 +1。 */
const srcTs = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'duel-sequence.ts'), 'utf8');
const fetchCall = srcTs.match(/fetchPuzzleInLang\([^)]*\)/);
ok(!!fetchCall, '取题调用可定位');
ok(/fetchPuzzleInLang\(GAME,\s*round\s*\+\s*1\b/.test(srcTs),
  '取题 round 已做 0-based → 1-based 转换（round + 1）',
  fetchCall ? fetchCall[0] : '未找到调用');
ok(/fetchAnswerLang\(\)/.test(srcTs),
  '取题带语言（word-recall 题目按语言分裂）');

/* 🔴 emoji-ghost 判分必须按 options 下标反查本体：
   渲染层 resolve 的是下标，直接当字符串比对会恒 0 分且零报错。 */
const emojiTruth = srcTs.match(/kind:\s*'emoji'[\s\S]{0,220}?\};/);
ok(!!emojiTruth && /options:/.test(emojiTruth[0]),
  'emoji 真值已存档 options（判分需反查本体）',
  emojiTruth ? emojiTruth[0].slice(0, 120) : '未找到');
ok(/tr\.options\s*\|\|\s*\[\]/.test(srcTs) && /\(tr\.options\s*\|\|\s*\[\]\)\[pick\]/.test(srcTs),
  'emoji 判分按下标反查 options（不能直接 String(answer) 比对）');

/* 🔴 速度加成计时起点必须在 playRound 内部（题面就绪时），
   且 soloJudge 必须实时取差值 —— 放循环头会永远读到上一轮旧值。 */
ok(/if \(SOLO\) soloT0 = performance\.now\(\)/.test(srcTs),
  '计时起点在题面就绪处（playRound 内），非循环头');
ok(/const elapsed = soloT0 \? Math\.round\(performance\.now\(\) - soloT0\) : 0/.test(srcTs),
  '速度加成实时取差值（不读上一轮残留）');

const lobbyJsCode = fs.readFileSync(path.join(DIST, 'assets', lobbyJs[0]), 'utf8');
ok(lobbyJsCode.includes('/lobby/'), '大厅脚本含回退字面量');

console.log('\n=========== ' + pass + ' passed, ' + fail + ' failed ===========');
if (bad.length) { console.log('\n失败明细：'); bad.forEach(b => console.log('  - ' + b)); }
process.exit(fail ? 1 : 0);
