/**
 * P1-12 「战书」卡片 + /j/ 短链 · 单测
 * ────────────────────────────────────────────────────────────────
 * 这个功能表面是「建房后多一张卡」，实际动了三处**错了就伤主**的地方，
 * 每一处都能在线上演成事故，所以逐条锁死：
 *
 *  1. **不能把房主丢在卡上不管**。好友一 join，房间满员，服务端
 *     autoStartIfFull() 就地开局（worker handleRoom）。房主若还停在卡上，
 *     十道题的时间会在他看卡片时被扣光 —— 比原来的「直接跳进去」更糟。
 *     所以必须有房间轮询，且看到满员就立刻进对局。
 *
 *  2. **短链必须是 302，不能是 301**。房码是按房间变化的：同一个 /j/ 路径，
 *     不同 code 是不同目标。301 会被浏览器长期缓存，房码就永远改不了。
 *
 *  3. **兜底文案必须走 t() 的第四参**。i18n 签名是
 *     `t(key, vars, lang, fallback)`；写成 t(key, fallback) 时兜底串落进
 *     vars 位，字典缺键就会把**裸 key** 打到屏幕上。
 *
 * 另外顺手守住两件「易漏」的事：卡片的 [hidden] 会被作者 display 盖掉、
 * 卡片里每个 data-i18n 的键在六种语言里都真的存在。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const REDIRECTS = path.join(ROOT, 'public/_redirects');
const LOBBY_TS = path.join(ROOT, 'src/pages/knowledge-lobby.ts');
const LOBBY_HTML = path.join(ROOT, 'games/knowledge-duel/lobby/index.html');
const LOBBY_CSS = path.join(ROOT, 'src/styles/knowledge-lobby.css');
const LANGS = ['en', 'zh', 'ja', 'es', 'fr', 'de'];

const read = (p) => fs.readFileSync(p, 'utf8');

/** 取 createRoom() 到下一个顶层 function 之间的源码 —— 只在这个窗口里断言 */
function createRoomBody(src) {
  const start = src.indexOf('function createRoom(');
  assert.ok(start > 0, '找不到 createRoom()');
  const rest = src.slice(start + 20);
  const nextFn = rest.search(/\nfunction [a-zA-Z]/);
  return nextFn < 0 ? rest : rest.slice(0, nextFn);
}

/* ═══════════ 1 · 短链：/j/* → train.html?room=:splat，且必须 302 ═══════════ */

test('_redirects 里有 /j/ 短链规则，占位符落在 room 查询串上', () => {
  const src = read(REDIRECTS);
  const line = src.split('\n').find((l) => /^\s*\/j\/\*/.test(l));
  assert.ok(line, '/j/* 规则缺失 —— 卡片上印的短链会 404');

  const parts = line.trim().split(/\s+/);
  assert.equal(parts[0], '/j/*');
  assert.equal(parts[1], '/train.html?room=:splat',
    '短链必须把捕获段喂给 train.html 的 room 参数，否则打开是空房间');
  assert.equal(parts[2], '302');
});

test('短链是 302，绝不允许 301（否则房码被浏览器永久缓存）', () => {
  const src = read(REDIRECTS);
  const jLines = src.split('\n').filter((l) => /^\s*\/j\//.test(l));
  assert.equal(jLines.length, 1, '/j/ 只应有一条规则，多条会互相覆盖');
  assert.ok(!/\s301\s*$/.test(jLines[0]),
    '/j/ 用了 301 —— 同一个短链路径对不同房码指向不同房间，永久重定向会把房码锁死');
});

/* ═══════════ 2 · 建房不再立刻跳转，而是先出卡 ═══════════ */

test('createRoom() 建房成功后不再 location.href，而是调 showWarCard()', () => {
  const body = createRoomBody(read(LOBBY_TS));
  assert.ok(/showWarCard\(/.test(body),
    'createRoom() 没有调 showWarCard() —— 房主还是看不到自己的房码');
  const nav = body.match(/location\.href\s*=/);
  assert.equal(nav, null,
    'createRoom() 里仍有 location.href —— 会把房主直接塞进对局，卡片等于不存在');
});

test('卡片里的「先开始」链接指向 train.html?room=CODE', () => {
  const src = read(LOBBY_TS);
  assert.ok(/startEl\.setAttribute\('href',\s*`\/train\.html\?room=\$\{encodeURIComponent\(code\)\}/.test(src),
    '「先开始」必须带上 room 参数，否则进的是空白对局页');
});

/* ═══════════ 3 · 房主不能干等在卡上：必须轮询房间 ═══════════ */

test('盯房间：轮询 /room/status，满员或已开局就进对局', () => {
  const src = read(LOBBY_TS);
  assert.ok(/function watchWarRoom\(/.test(src), '缺少 watchWarRoom() —— 房主会被扣光时间');
  assert.ok(/\/api\/md\/room\/status\?code=/.test(src), '轮询端点写错（应为 /api/md/room/status）');
  // 满员判定：不能只等 status==='playing'
  assert.ok(/seated\s*>=\s*2/.test(src),
    '没有按「已落座人数」提前出手 —— 只等 playing 会晚一个往返，房主丢第一题');
  assert.ok(/d\.status === 'playing'/.test(src), '没有判断 playing 状态');
  assert.ok(/enterRoom\(code\)/.test(src), '在卡上停留时不会自动进入对局');
});

test('轮询有上限、可停止，不会无限空转', () => {
  const src = read(LOBBY_TS);
  assert.ok(/WAR_MAX_MS/.test(src), '缺少最长等待上限');
  assert.ok(/function stopWarWatch\(/.test(src), '缺少 stopWarWatch()');
  assert.ok(/warClosed/.test(src), '缺少 warClosed 短路 —— 点「先开始」后仍可能二次跳转');
});

test('点「先开始」会停表（避免导航中再触发一次 enterRoom）', () => {
  const src = read(LOBBY_TS);
  // 注意：showWarCard() 里也有一处 el<HTMLAnchorElement>('kbWarStart')（取元素设 href），
  // 必须连 addEventListener 一起匹配，否则会断到那个不带监听的赋值上。
  const i = src.indexOf("el<HTMLAnchorElement>('kbWarStart')?.addEventListener");
  assert.ok(i > 0, '「先开始」没有绑定事件');
  const seg = src.slice(i, i + 260);
  assert.ok(/warClosed = true/.test(seg) && /stopWarWatch\(\)/.test(seg),
    '「先开始」没有停表：导航过程中轮询回调可能再跳一次');
});

/* ═══════════ 4 · 复制 / 分享：必须有老浏览器退路 ═══════════ */

test('复制走 Clipboard API，并保留 execCommand 退路（微信内置浏览器）', () => {
  const src = read(LOBBY_TS);
  assert.ok(/clipboard/.test(src) && /writeText/.test(src), '没有用 Clipboard API');
  assert.ok(/execCommand\('copy'\)/.test(src), '缺少 execCommand 退路 —— 微信里会复制不出来');
  assert.ok(/\.catch\(\(\) => legacyCopy\(text\)\)/.test(src),
    'Clipboard 被拒时没有回落（部分 WebView 里 writeText 存在但会 reject）');
});

test('系统分享按钮只在 navigator.share 存在时才显示', () => {
  const src = read(LOBBY_TS);
  assert.ok(/typeof \(navigator as Navigator & \{ share\?: unknown \}\)\.share === 'function'/.test(src),
    '没有探测 navigator.share —— 桌面端会留下一个点了没反应的按钮');
  assert.ok(/shareBtn\.hidden = !canShare/.test(src));
});

test('「存图片」复用 share-card.ts，二维码 game 用 quiz', () => {
  const src = read(LOBBY_TS);
  assert.ok(/from '\.\.\/games\/share-card'/.test(src), '没有复用 share-card.ts（会另起一套画图逻辑）');
  assert.ok(/qrGame: 'quiz'/.test(src),
    "qrGame 必须写 'quiz' —— worker 的 MD_GAMES 用它决定二维码指向 /train.html");
  assert.ok(/url: shareUrl\(warCode\)/.test(src), '卡片 URL 应取短链，与复制出的同一串');
});

/* ═══════════ 5 · 兜底文案：必须走 t() 的第四参 ═══════════ */

test('tr() 把 fallback 传到 t() 的第四参（不是第二参）', () => {
  const src = read(LOBBY_TS);
  const i = src.indexOf('function tr(');
  const body = src.slice(i, i + 900);
  assert.ok(/fn\(key, undefined, undefined, fallback\)/.test(body),
    'tr() 没有把 fallback 传到第四参 —— 缺键时屏幕上会出现裸 key');
  assert.ok(!/__t\(key, fallback\)/.test(body) && !/g\.t\(key, fallback\)/.test(body),
    'tr() 仍在用 t(key, fallback)：兜底串会被当成插值变量对象');
});

/* ═══════════ 6 · 卡片 DOM：静态在 HTML 里，且 [hidden] 真能藏住 ═══════════ */

test('大厅 HTML 里有战书卡，默认 hidden，关键节点齐全', () => {
  const html = read(LOBBY_HTML);
  const tag = html.match(/<section[^>]*id="kbWar"[^>]*>/);
  assert.ok(tag, '找不到 #kbWar');
  assert.ok(/\bhidden\b/.test(tag[0]), '#kbWar 默认必须是 hidden（否则首屏就顶着一张空卡）');
  for (const id of ['kbWarCode', 'kbWarLink', 'kbWarCopy', 'kbWarStart', 'kbWarWait', 'kbWarMsg']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  }
  // 「先开始」必须有 text 节点，i18n 才能改词
  assert.ok(/id="kbWarStart"[\s\S]{0,220}data-i18n="duel\.start"/.test(html),
    '「先开始」没有挂 data-i18n，切语言不会跟着变');
});

test('CSS 显式写了 .kb-war[hidden]{display:none}', () => {
  const css = read(LOBBY_CSS);
  const block = css.slice(css.indexOf('.kb-war{'));
  assert.ok(/display\s*:\s*flex/.test(block.slice(0, 400)), '.kb-war 应该是 flex 布局');
  assert.ok(/\.kb-war\[hidden\]\s*\{\s*display\s*:\s*none/.test(css),
    '.kb-war 设了 display:flex 却没写 [hidden] 兜底 —— 作者样式会盖掉 [hidden]，卡片永远显示');
});

test('房码排版：等宽数字 + 拉开字距 + 触控目标 ≥44px', () => {
  const css = read(LOBBY_CSS);
  const i = css.indexOf('.kb-war-code{');
  assert.ok(i > 0, '缺少 .kb-war-code');
  const rule = css.slice(i, css.indexOf('}', i));
  assert.ok(/font-variant-numeric\s*:\s*tabular-nums/.test(rule),
    '房码没有 tabular-nums —— 数字宽度不一，码会左右跳');
  assert.ok(/letter-spacing\s*:\s*\.26em/.test(rule), '房码没有拉开字距（登机牌感）');
  assert.ok(/text-indent\s*:\s*\.26em/.test(rule),
    '缺少 text-indent 补偿 —— 末字后的字距会让整串看起来偏左');

  assert.ok(/\.kb-war-act\{[^}]*min-height\s*:\s*44px/.test(css), '按钮触控高度不足 44px');
  assert.ok(/\.kb-war-start\{[^}]*min-height\s*:\s*44px/.test(css), '「先开始」触控高度不足 44px');
});

/* ═══════════ 7 · i18n：新键六语齐全，卡片里每个键都真的存在 ═══════════ */

const flatGet = (obj, key) => key.split('.').reduce((a, p) => (a && typeof a === 'object' ? a[p] : undefined), obj);
const dicts = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(read(path.join(ROOT, `public/i18n/${l}.json`)))]));

test('dl.war_title / dl.war_sub 在六种语言里都有值', () => {
  for (const key of ['dl.war_title', 'dl.war_sub']) {
    for (const l of LANGS) {
      const v = flatGet(dicts[l], key);
      assert.equal(typeof v, 'string', `${l}.json 缺 ${key}`);
      assert.ok(v.length > 0, `${l}.json 的 ${key} 是空串`);
    }
  }
});

test('战书卡里每个 data-i18n 键在英文词典里都存在', () => {
  const html = read(LOBBY_HTML);
  const start = html.indexOf('id="kbWar"');
  const card = html.slice(start, html.indexOf('</section>', start));
  const keys = [...card.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 5, '卡片上的 data-i18n 键太少，可能标记写漏了');
  for (const k of keys) {
    assert.notEqual(flatGet(dicts.en, k), undefined, `卡片引用了不存在的 i18n 键：${k}`);
  }
});

test('tr() 在 TS 里用到的键也都在词典里（兜底只该在字典没加载时生效）', () => {
  const src = read(LOBBY_TS);
  const keys = new Set([...src.matchAll(/tr\('([a-z0-9_]+\.[a-z0-9_]+)'/g)].map((m) => m[1]));
  assert.ok(keys.size > 0);
  for (const k of keys) {
    assert.notEqual(flatGet(dicts.en, k), undefined, `tr() 用了不存在的键：${k}`);
  }
});
