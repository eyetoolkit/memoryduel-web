/* ═══════════════════════════════════════════════════════════════
   memoryduel · 分品类段位（P1-9，2026-11-24）
   ───────────────────────────────────────────────────────────────
   干什么：把「你在某个分类上答了多少题、对了多少」记进 localStorage，
   折算成一个段位徽章，显示在大厅的分类格子上。

   🔴 三条红线（改之前先想清楚）：
     1. **纯展示，绝不参与任何结算**。它是 localStorage 里的两个整数，
        用户 F12 就能改成钻石。一旦让它影响金币 / 排名 / 匹配 / 难度，
        就是现成的作弊入口。真正的成绩口径只有服务端的 scoreFor + D1。
     2. **不记题目内容**。只存 [答题数, 答对数]，不落题干、选项、qid ——
        存了就等于在用户浏览器里留一份题库副本，白送竞争对手。
     3. **一局只写一次**。逐题写 localStorage 在 iOS 私密模式会撞
        QuotaExceeded 而被静默吞掉；record() 收整批、写一次。

   为什么段位要「题数 + 准确率」双条件：
     只看准确率 → 答 1 题蒙对的萌新直接封顶；
     只看题数   → 乱点一百题也能升段。
     两个都卡，才有「越打越准才升段」的正反馈，也顺手挡住了刷量。

   门槛（n = 该分类累计答题数，acc = 准确率）：
     青铜 n≥3 / 白银 n≥10,acc≥50% / 黄金 n≥20,acc≥70%
     铂金 n≥35,acc≥82% / 钻石 n≥50,acc≥90%
   ═══════════════════════════════════════════════════════════════ */

export const KEY = 'md_cat_tiers_v1';
export const VERSION = 1;

/* 12 个分类 id，与 worker 侧 quiz.CATS 一致。
   不在表里的一律丢弃 —— 历史上的 'all' / 'mixed' 不该长出假分类。 */
export const CATS = [
  'science', 'history', 'geography', 'sports', 'movies', 'tech',
  'culture', 'general', 'games', 'music', 'nature', 'arts',
];

export const TIERS = [
  { key: 'bronze',   n: 3,  acc: 0 },
  { key: 'silver',   n: 10, acc: 0.50 },
  { key: 'gold',     n: 20, acc: 0.70 },
  { key: 'platinum', n: 35, acc: 0.82 },
  { key: 'diamond',  n: 50, acc: 0.90 },
];

/* 段位名走模块内自带表，不塞进 /i18n/*.json：
   ① 它是游戏自己的词汇，不是站点文案；
   ② 每加一个键就要 bump VERSION + 改 27 个 HTML 的 dictVersion，
      漏一个就渲染出 `dl.tier_gold` 这种 key 原文（这个坑已经踩过）。 */
const LABELS = {
  en: ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'],
  zh: ['青铜', '白银', '黄金', '铂金', '钻石'],
  ja: ['ブロンズ', 'シルバー', 'ゴールド', 'プラチナ', 'ダイヤモンド'],
  es: ['Bronce', 'Plata', 'Oro', 'Platino', 'Diamante'],
  fr: ['Bronze', 'Argent', 'Or', 'Platine', 'Diamant'],
  de: ['Bronze', 'Silber', 'Gold', 'Platin', 'Diamant'],
};
const UNRANKED = {
  en: 'Unranked', zh: '未定级', ja: '未ランク',
  es: 'Sin rango', fr: 'Non classé', de: 'Ohne Rang',
};
/* 距离下一段还差什么。{n}=还差几题，{p}=准确率还差几个百分点 */
const NEED_N = {
  en: '{n} more to {t}', zh: '再答 {n} 题到{t}', ja: '{t}まであと{n}問',
  es: '{n} más para {t}', fr: '{n} de plus pour {t}', de: 'Noch {n} bis {t}',
};
const NEED_ACC = {
  en: '+{p}% accuracy for {t}', zh: '准确率再 +{p}% 到{t}', ja: '{t}まで精度+{p}%',
  es: '+{p}% de precisión para {t}', fr: '+{p}% de précision pour {t}', de: '+{p}% Genauigkeit bis {t}',
};

/* 单分类累计题数上限：防止 localStorage 被写爆，也拦住「挂机刷到十万题」 */
const MAX_N = 100000;

function pickLang(lang) {
  const l = String(lang || 'en').toLowerCase().slice(0, 2);
  return LABELS[l] ? l : 'en';
}

/* localStorage 可能整个不可用（Safari 私密模式 / iframe 三方可信性 / 被策略禁用）。
   所有读写都必须容错 —— 段位记不上是小事，把页面搞崩是大事。 */
function ls() {
  try {
    return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
  } catch (e) { return null; }
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** 读出全部分类统计：{ cat: [n, ok] }。坏数据一律丢，绝不抛。 */
export function readAll() {
  const s = ls();
  if (!s) return {};
  let raw = null;
  try { raw = s.getItem(KEY); } catch (e) { return {}; }
  if (!raw) return {};
  let o = null;
  try { o = JSON.parse(raw); } catch (e) { return {}; }
  if (!o || o.v !== VERSION || !o.c || typeof o.c !== 'object') return {};
  const out = {};
  for (const k of Object.keys(o.c)) {
    if (CATS.indexOf(k) < 0) continue;
    const a = o.c[k];
    if (!Array.isArray(a) || a.length < 2) continue;
    const n = clampInt(a[0], 0, MAX_N);
    const ok = clampInt(a[1], 0, n);
    if (n > 0) out[k] = [n, ok];
  }
  return out;
}

function writeAll(all) {
  const s = ls();
  if (!s) return false;
  try {
    s.setItem(KEY, JSON.stringify({ v: VERSION, c: all }));
    return true;
  } catch (e) {
    /* 配额满 / 私密模式：静默放弃，不影响答题 */
    return false;
  }
}

/**
 * 记录一批作答。pairs: [{ cat, ok }]
 * 一局 10 题调一次即可（不是每题调一次）。
 * 返回 { changed } —— changed=0 表示没有任何合法分类，调用方无需关心。
 */
export function record(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return { changed: 0 };
  const all = readAll();
  let changed = 0;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (!p) continue;
    const cat = String(p.cat || '');
    if (CATS.indexOf(cat) < 0) continue;
    const cur = all[cat] || [0, 0];
    const n = Math.min(MAX_N, cur[0] + 1);
    const ok = Math.min(n, cur[1] + (p.ok ? 1 : 0));
    all[cat] = [n, ok];
    changed++;
  }
  if (!changed) return { changed: 0 };
  writeAll(all);
  return { changed };
}

/** 单个分类的统计。没作答过返回 { n:0, ok:0, acc:0 }。 */
export function stat(cat) {
  const all = readAll();
  const a = all[String(cat || '')] || [0, 0];
  return { n: a[0], ok: a[1], acc: a[0] ? a[1] / a[0] : 0 };
}

/**
 * 由 (n, ok) 算段位。idx = -1 表示未定级。
 * next 为升到下一段还缺什么：{ idx, need(还差几题), accNeed(还差几个百分点) }，
 * 已到顶（钻石）时 next = null。
 */
export function tierOf(n, ok) {
  const nn = Math.max(0, Math.floor(Number(n) || 0));
  const oo = Math.max(0, Math.min(nn, Math.floor(Number(ok) || 0)));
  const acc = nn ? oo / nn : 0;
  let idx = -1;
  for (let i = 0; i < TIERS.length; i++) {
    if (nn >= TIERS[i].n && acc >= TIERS[i].acc) idx = i;
  }
  let next = null;
  if (idx + 1 < TIERS.length) {
    const t = TIERS[idx + 1];
    next = {
      idx: idx + 1,
      need: Math.max(0, t.n - nn),
      accNeed: Math.max(0, Math.round((t.acc - acc) * 100)),
    };
  }
  return { idx, acc, n: nn, ok: oo, next };
}

/** 段位名。idx=-1 → 未定级。 */
export function label(idx, lang) {
  const l = pickLang(lang);
  if (idx < 0 || idx >= TIERS.length) return UNRANKED[l];
  return LABELS[l][idx];
}

/** 「再答 N 题 / 准确率再 +P% 到 X」，两种缺口都满足不了就返回空串。 */
export function hint(n, ok, lang) {
  const l = pickLang(lang);
  const t = tierOf(n, ok);
  if (!t.next) return '';
  const name = LABELS[l][t.next.idx];
  if (t.next.accNeed > 0) {
    return NEED_ACC[l].replace('{p}', String(t.next.accNeed)).replace('{t}', name);
  }
  if (t.next.need > 0) {
    return NEED_N[l].replace('{n}', String(t.next.need)).replace('{t}', name);
  }
  return '';
}

/**
 * 大厅分类卡的徽章数据（渲染层只管拼 DOM，判定逻辑全在这里）。
 * 返回：
 *   { idx, key, text, title }
 *   idx  = -1 未定级 → text 为空串（调用方据此决定不画徽章）
 *   key  = 'bronze'|'silver'|'gold'|'platinum'|'diamond'，用于 CSS 上色
 *   text = 徽章上的短字（段位名首字母/短名，由 CSS 控制大小）
 *   title= 悬停/无障碍长文案：「Gold · 72% · next: +3 more」这类
 *
 * 🔴 未定级时 title 也给出「再答几题到青铜」的引导，
 *    否则新用户看到一片空白格子，不知道这个功能存在。
 */
export function badge(cat, lang) {
  const st = stat(cat);
  const t = tierOf(st.n, st.ok);
  const next = hint(st.n, st.ok, lang);
  if (t.idx < 0) {
    return { idx: -1, key: '', text: '', title: next || label(-1, lang) };
  }
  const name = label(t.idx, lang);
  const pct = Math.round(t.acc * 100);
  return {
    idx: t.idx,
    key: TIERS[t.idx].key,
    text: name,
    title: name + ' · ' + pct + '%' + (next ? ' · ' + next : ''),
  };
}

/** 全站汇总：{ n, ok, acc, ranked }，ranked = 已定级的分类数。 */
export function summary() {
  const all = readAll();
  let n = 0, ok = 0, ranked = 0;
  for (const k of Object.keys(all)) {
    n += all[k][0];
    ok += all[k][1];
    if (tierOf(all[k][0], all[k][1]).idx >= 0) ranked++;
  }
  return { n, ok, acc: n ? ok / n : 0, ranked };
}

/* 非打包页面（public/train.html、public/daily/）直接用 window.CategoryTiers；
   打包页面也可以走这条，省掉一次动态 import 的路径解析。 */
if (typeof window !== 'undefined') {
  window.CategoryTiers = {
    KEY, CATS, TIERS, readAll, record, stat, tierOf, label, hint, badge, summary,
  };
}
