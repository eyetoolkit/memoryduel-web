/**
 * P1-9 分品类段位（localStorage）· 单测
 * ────────────────────────────────────────────────────────────────
 * 这套功能是「纯装饰」：答完一局，把该分类的 [答题数, 答对数] 加一加，
 * 大厅分类卡上多一个小徽章。正因为装饰，它有三条一旦破了就会伤主的红线：
 *
 *  1. **绝不能参与结算**。数据在 localStorage，用户 F12 就能改成钻石；
 *     一旦拿它排序/推荐/限制难度/影响匹配，就是一个白送的分身入口。
 *  2. **不能崩**。私密模式 / 配额满 / 被策略禁用时 setItem 会抛，
 *     段位记不上是小事，把结算页搞崩是大事。
 *  3. **一局只写一次**。逐题写会撞配额，也会让「一局 10 题」变成 10 次 IO。
 *
 * 下面按这三条 + 门槛边界 + 大厅装配 分五组锁死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MOD = path.join(ROOT, 'public/js/category-tiers.mjs');
const LOBBY_TS = path.join(ROOT, 'src/pages/knowledge-lobby.ts');
const BATTLE_TS = path.join(ROOT, 'src/pages/battle.ts');
const TRAIN_HTML = path.join(ROOT, 'public/train.html');
const BATTLE_HTML = path.join(ROOT, 'battle.html');
const LOBBY_HTML = path.join(ROOT, 'games/knowledge-duel/lobby/index.html');

const modUrl = new URL(MOD, 'file://');
const T = await import(modUrl.href);

/** 造一个内存 localStorage，并统计写次数（红线 3：一局只写一次） */
function fakeStore(seed) {
  const map = new Map();
  if (seed !== undefined) map.set(T.KEY, seed);
  return {
    map,
    writes: 0,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { this.writes++; map.set(k, v); },
    removeItem(k) { map.delete(k); },
  };
}

/** 在指定 store 下跑一段，结束后还原全局（避免污染其它测试） */
function withStore(store, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const prev = globalThis.localStorage;
  globalThis.localStorage = store;
  try { return fn(); } finally {
    if (had) globalThis.localStorage = prev;
    else delete globalThis.localStorage;
  }
}

/* ═══════════════════════════════════════════════════════════════
   1. 段位门槛：题数 + 准确率**双条件**
   ═══════════════════════════════════════════════════════════════ */
test('门槛：题数不够不给段位，蒙对 1 题不能封顶', () => {
  assert.equal(T.tierOf(0, 0).idx, -1, '0 题 = 未定级');
  assert.equal(T.tierOf(2, 2).idx, -1, '2 题全对也不能定级（n<3）');
  assert.equal(T.tierOf(3, 0).idx, 0, '青铜只看题数，0% 也算（n≥3）');
  assert.equal(T.tierOf(3, 3).idx, 0, '3 题全对 = 青铜，不是白银（n<10）');
  assert.equal(T.tierOf(1, 1).idx, -1, '1 题 100% 仍是未定级 —— 只看准确率必然封顶，所以加了题数门');
});

test('门槛：白银/黄金/铂金/钻石的边界', () => {
  // 白银 n≥10 且 acc≥50%
  assert.equal(T.tierOf(9, 9).idx, 0, '9 题全对 = 青铜（差一题到白银）');
  assert.equal(T.tierOf(10, 5).idx, 1, '10 题 50% = 白银（刚好压线）');
  assert.equal(T.tierOf(10, 4).idx, 0, '10 题 40% 停在青铜');
  // 黄金 n≥20 且 acc≥70%
  assert.equal(T.tierOf(20, 14).idx, 2, '20 题 70% = 黄金（压线）');
  assert.equal(T.tierOf(20, 13).idx, 1, '20 题 65% 停在白银');
  assert.equal(T.tierOf(19, 19).idx, 1, '19 题全对仍是白银（题数不够）');
  // 铂金 n≥35 且 acc≥82%
  assert.equal(T.tierOf(35, 29).idx, 3, '35 题 82.9% = 铂金');
  assert.equal(T.tierOf(35, 28).idx, 2, '35 题 80% 停在黄金');
  // 钻石 n≥50 且 acc≥90%
  assert.equal(T.tierOf(50, 45).idx, 4, '50 题 90% = 钻石（压线）');
  assert.equal(T.tierOf(50, 44).idx, 3, '50 题 88% 停在铂金');
  assert.equal(T.tierOf(100000, 90000).idx, 4, '长期积累不会越界');
});

test('tierOf 对脏输入做钳制：ok 不得超过 n，负数归零', () => {
  const a = T.tierOf(-5, 3);
  assert.equal(a.n, 0); assert.equal(a.ok, 0); assert.equal(a.idx, -1);
  const b = T.tierOf(10, 99);
  assert.equal(b.ok, 10, 'ok 被钳到 n，acc=1');
  assert.equal(b.acc, 1);
});

test('hint：缺题数时说「还差几题」，缺准确率时说「还差几个点」', () => {
  assert.match(T.hint(0, 0, 'en'), /3 more to Bronze/, '0 题 → 还差 3 题到青铜');
  assert.match(T.hint(10, 4, 'en'), /\+10% accuracy for Silver/, '白银缺 10 个点');
  assert.equal(T.hint(50, 45, 'en'), '', '已到钻石，没有下一段 → 空串');
  assert.match(T.hint(0, 0, 'zh'), /再答 3 题到青铜/, '中文文案走模块内表，不进 i18n 字典');
});

/* ═══════════════════════════════════════════════════════════════
   2. 存储：只认白名单分类、脏数据一律丢（红线 1 的前置）
   ═══════════════════════════════════════════════════════════════ */
test('分类白名单 = 题库的 12 个，未知分类丢弃不落盘', () => {
  assert.deepEqual(
    T.CATS.slice().sort(),
    ['arts', 'culture', 'games', 'general', 'geography', 'history',
      'movies', 'music', 'nature', 'science', 'sports', 'tech'],
  );
  const store = fakeStore();
  withStore(store, () => {
    const r = T.record([
      { cat: 'science', ok: true },
      { cat: 'all', ok: true },        // 历史上的伪分类
      { cat: 'mixed', ok: true },
      { cat: '', ok: true },
      { cat: 'nope', ok: true },
    ]);
    assert.equal(r.changed, 1, '只有 science 合法');
    const all = T.readAll();
    assert.deepEqual(Object.keys(all), ['science']);
  });
});

test('record 累加：同一批里同分类的多题会合并计数', () => {
  const store = fakeStore();
  withStore(store, () => {
    T.record([
      { cat: 'history', ok: true }, { cat: 'history', ok: false }, { cat: 'history', ok: true },
    ]);
    const s = T.stat('history');
    assert.equal(s.n, 3); assert.equal(s.ok, 2);
    assert.ok(Math.abs(s.acc - 2 / 3) < 1e-9);
    // 第二局继续累加
    T.record([{ cat: 'history', ok: true }]);
    assert.equal(T.stat('history').n, 4);
    assert.equal(T.stat('history').ok, 3);
  });
});

test('红线 3：一次 record() 只写一次 localStorage', () => {
  const store = fakeStore();
  withStore(store, () => {
    T.record(Array.from({ length: 10 }, () => ({ cat: 'science', ok: true })));
    assert.equal(store.writes, 1, '一局 10 题必须合并成 1 次写，不是 10 次');
  });
});

test('readAll 容错：坏 JSON / 版本不符 / 形状不对 都退化成空表而不是抛', () => {
  for (const bad of ['{', 'null', '[]', '"x"', '{"v":0,"c":{}}', '{"v":1,"c":[1,2]}', '{"v":1,"c":{"science":"x"}}']) {
    const store = fakeStore(bad);
    withStore(store, () => {
      assert.deepEqual(T.readAll(), {}, `坏数据 ${bad} 应退化成 {}`);
      assert.equal(T.stat('science').n, 0);
    });
  }
});

test('readAll 越界数据被钳制：ok>n 收成 ok=n，n=0 的分类不出现', () => {
  const store = fakeStore(JSON.stringify({
    v: T.VERSION,
    c: { science: [5, 99], history: [0, 0], general: [3, 1], 'all': [7, 7] },
  }));
  withStore(store, () => {
    const all = T.readAll();
    assert.deepEqual(all.science, [5, 5]);
    assert.deepEqual(all.general, [3, 1]);
    assert.equal(all.history, undefined, 'n=0 不占位');
    assert.equal(all.all, undefined, '非白名单分类剔除');
  });
});

test('红线 2：localStorage 抛异常时不崩、不返回半截数据', () => {
  const boom = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('nope'); },
  };
  withStore(boom, () => {
    assert.deepEqual(T.readAll(), {}, '读失败 → 空表');
    assert.doesNotThrow(() => T.record([{ cat: 'science', ok: true }]), '写失败必须静默');
    assert.deepEqual(T.summary(), { n: 0, ok: 0, acc: 0, ranked: 0 });
  });
  // localStorage 整个不存在（Node / 被策略禁用）
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const prev = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    assert.doesNotThrow(() => T.record([{ cat: 'science', ok: true }]));
    assert.deepEqual(T.readAll(), {});
  } finally {
    if (had) globalThis.localStorage = prev;
  }
});

/* ═══════════════════════════════════════════════════════════════
   3. 大厅徽章：未定级不画、定级给出可读文案
   ═══════════════════════════════════════════════════════════════ */
test('badge：未定级 text 为空（大厅据此不画徽章但要占位）', () => {
  const store = fakeStore();
  withStore(store, () => {
    const b = T.badge('music', 'en');
    assert.equal(b.idx, -1);
    assert.equal(b.text, '', 'text 空 = 不画徽章');
    assert.match(b.title, /3 more to Bronze/, 'title 里要给「怎么才能有段位」的引导');
  });
});

test('badge：定级后给出段位名 + 准确率 + 升段提示', () => {
  const store = fakeStore();
  withStore(store, () => {
    T.record(Array.from({ length: 20 }, (_, i) => ({ cat: 'tech', ok: i < 14 })));
    const b = T.badge('tech', 'en');
    assert.equal(b.idx, 2);
    assert.equal(b.key, 'gold');
    assert.equal(b.text, 'Gold');
    assert.match(b.title, /Gold · 70%/);
    assert.match(b.title, /Platinum/, 'title 里带上下一段目标');
    // 中文
    const zh = T.badge('tech', 'zh');
    assert.equal(zh.text, '黄金');
  });
});

test('summary：全站汇总不受未定级分类影响', () => {
  const store = fakeStore();
  withStore(store, () => {
    T.record([
      { cat: 'science', ok: true }, { cat: 'science', ok: true }, { cat: 'science', ok: false },
      { cat: 'arts', ok: true }, { cat: 'arts', ok: true }, { cat: 'arts', ok: true },
    ]);
    const s = T.summary();
    assert.equal(s.n, 6); assert.equal(s.ok, 5);
    assert.equal(s.ranked, 2, '两个分类都过了青铜线（n≥3）');
  });
});

test('六语段位名齐全（缺一个就会在界面上现形）', () => {
  for (const l of ['en', 'zh', 'ja', 'es', 'fr', 'de']) {
    const names = [0, 1, 2, 3, 4].map((i) => T.label(i, l));
    for (const n of names) assert.ok(n && typeof n === 'string', `${l} 段位名缺失`);
    assert.equal(new Set(names).size, 5, `${l} 五个段位名不能重复`);
    assert.ok(T.label(-1, l));
  }
  assert.equal(T.label(0, 'xx'), 'Bronze', '未知语言回落 en');
});

/* ═══════════════════════════════════════════════════════════════
   4. 浏览器装配：window.CategoryTiers 必须挂全（三个页面都靠它）
   ═══════════════════════════════════════════════════════════════ */
test('window.CategoryTiers 暴露给非打包页面使用，且方法齐全', async () => {
  const hadWin = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prevWin = globalThis.window;
  globalThis.window = globalThis;
  try {
    // 带 query 的 URL 是一份独立的模块实例，会重跑尾部挂载逻辑
    const fresh = await import(modUrl.href + '?win=1');
    const api = globalThis.CategoryTiers;
    assert.ok(api, 'window.CategoryTiers 必须挂上');
    for (const k of ['readAll', 'record', 'stat', 'tierOf', 'label', 'hint', 'badge', 'summary']) {
      assert.equal(typeof api[k], 'function', `CategoryTiers.${k} 缺失`);
    }
    assert.equal(api.KEY, T.KEY);
    assert.equal(api.CATS.length, 12);
    assert.ok(fresh);
  } finally {
    if (hadWin) globalThis.window = prevWin;
    else {
      delete globalThis.window;
      try { delete globalThis.CategoryTiers; } catch (_) { /* ignore */ }
    }
  }
});

/* ═══════════════════════════════════════════════════════════════
   5. 三个落点都接上了（改前端时最容易漏的就是这一环）
   ═══════════════════════════════════════════════════════════════ */
test('三个页面都加载了同一份模块，且没各自复制实现', () => {
  for (const [file, label] of [
    [BATTLE_HTML, '/battle/'],
    [TRAIN_HTML, 'train.html'],
    [LOBBY_HTML, '大厅页'],
  ]) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /\/js\/category-tiers\.mjs/, `${label} 必须加载 /js/category-tiers.mjs`);
  }
  const workerSrc = fs.readFileSync(MOD, 'utf8');
  // 只有一份实现：其它地方不得再写一遍段位门槛表
  for (const other of [LOBBY_TS, BATTLE_TS, TRAIN_HTML]) {
    const s = fs.readFileSync(other, 'utf8');
    assert.ok(!/platinum\s*:\s*35|n:\s*35,\s*acc:\s*0\.82/.test(s),
      `${path.basename(other)} 里又出现了一份段位门槛 —— 规则只能住在 category-tiers.mjs`);
  }
  assert.match(workerSrc, /export function tierOf/);
});

test('battle.ts：一局只在 finish() 落一次盘，且整段 try/catch', () => {
  const s = fs.readFileSync(BATTLE_TS, 'utf8');
  const flushCalls = s.match(/flushTiers\(\)/g) || [];
  assert.equal(flushCalls.length, 2, '1 次定义 + 1 次调用（finish 里），多一处就是重复写盘');
  assert.match(s, /function finish\(\)[\s\S]{0,400}?flushTiers\(\)/, 'finish() 开头就要落盘');
  assert.match(s, /try \{ api\.record\(/, 'record 必须在 try 里 —— 私密模式会抛');
  // 段位绝不能进结算：本页不读 coins/score 相关 API，也不能拿段位改分
  assert.ok(!/tierBuf[^;]*solvedCount\s*=/.test(s), '段位不得反向影响得分');
});

test('train.html：对错的两个落点（paintReveal / onOnlineAnswer）都记了段位', () => {
  const s = fs.readFileSync(TRAIN_HTML, 'utf8');
  assert.match(s, /function paintReveal\(r\) \{\s*\/\*[\s\S]{0,400}?markTier\(r && r\.round, r && r\.correct\)/,
    'paintReveal 是服务端揭晓与本地练习的共同出口，必须在这里记');
  assert.match(s, /markTier\(OL\.idx, r && r\.correct\)/, '在线局的对错只来自 /api/md/answer');
  assert.match(s, /markTier\(OL\.idx, false\)/, '超时也要记一次错，否则成了刷量漏洞');
  const flushCalls = s.match(/flushTiers\(\);/g) || [];
  assert.equal(flushCalls.length, 2, '两个结算入口各一次：submitResult（服务端/练习）+ finishOnline（在线局）');
  assert.match(s, /function flushTiers\(\) \{\s*if \(TIERS_FLUSHED\) return;/, '必须有「只写一次」的闸门');
  assert.match(s, /try \{ api\.record\(pairs\); \} catch/, 'record 必须在 try 里 —— 私密模式会抛');
});

test('knowledge-lobby.ts：未定级也渲染空占位，避免同一行卡片高低不齐', () => {
  const s = fs.readFileSync(LOBBY_TS, 'utf8');
  assert.match(s, /function tierBadge/);
  assert.match(s, /<span class="ct" aria-hidden="true"><\/span>/, '未定级返回空 span 占位');
  assert.match(s, /tier-\$\{esc\(b\.key\)\}/, '定级后按 key 上色');
  assert.match(s, /pageshow/, 'bfcache 返回大厅要重渲，否则徽章是开局前的旧值');
});
