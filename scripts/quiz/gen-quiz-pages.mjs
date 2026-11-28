#!/usr/bin/env node
/**
 * gen-quiz-pages.mjs — /quiz/<slug>/ 主题题库页生成器（2026-11-28）
 * ────────────────────────────────────────────────────────────────
 * 设计约束（这几条是刻意的，改之前先想清楚）：
 *
 * 1. **纯脚本、不联网、不调 AI**。
 *    同一份语料跑两次必须字节一致（除 lastmod 日期）。原因是这条链路
 *    旁边那条 AI 代理链经常挂，题库页是流量主资产，不能挂在它上面。
 *
 * 2. **产物是静态 HTML，提交进仓库**。
 *    CF Pages 构建时连不到 D1，所以页面必须在生成阶段就把题目写进 HTML。
 *    语料（corpus.json）不进仓库，由 scripts/quiz/fetch-corpus.mjs 现拉。
 *
 * 3. **答案必须可被抓取**。
 *    答题器是 JS 增强层（/quiz/quiz.js），页面底下永远有一份完整的
 *    答案区（题目 + 正确选项 + 解析）。即使 JS 全挂，页面也是有用的。
 *
 * 用法：
 *   node scripts/quiz/gen-quiz-pages.mjs \
 *     --corpus /tmp/quiz-corpus.json \
 *     --topics data/quiz-topics.csv \
 *     --copy   data/quiz-copy.json \
 *     --out    public/quiz
 */

import fs from 'node:fs';
import path from 'node:path';

/* ────────────────── 参数 ────────────────── */

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

const ROOT = process.cwd();
const CORPUS = path.resolve(ROOT, arg('corpus', '/tmp/quiz-corpus.json'));
const TOPICS = path.resolve(ROOT, arg('topics', 'data/quiz-topics.csv'));
const COPY = path.resolve(ROOT, arg('copy', 'data/quiz-copy.json'));
const OUT = path.resolve(ROOT, arg('out', 'public/quiz'));

const SITE = 'https://www.memoryduel.com';
const PER_PAGE = Number(arg('per', '15'));
const MIN_POOL = 10;      // 少于这么多题的 tag 直接跳过，页面撑不起内容
const TODAY = new Date().toISOString().slice(0, 10);

/* ────────────────── 小工具 ────────────────── */

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
function word(n) { return WORD[n] || String(n); }

function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }

/* ────────────────── 读主题清单 ────────────────── */

function readTopics(file) {
  if (!fs.existsSync(file)) throw new Error('主题清单不存在: ' + file);
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const head = lines.shift().split(',').map((s) => s.trim());
  const idx = {};
  head.forEach((h, i) => { idx[h] = i; });
  for (const need of ['tag', 'slug', 'cat']) {
    if (idx[need] == null) throw new Error('清单缺少列: ' + need);
  }
  return lines.map((line) => {
    const c = line.split(',');
    return {
      tag: (c[idx.tag] || '').trim(),
      slug: (c[idx.slug] || '').trim(),
      cat: (c[idx.cat] || '').trim(),
      tier: idx.tier != null ? (c[idx.tier] || '').trim() : '',
      declared: idx.count != null ? Number(c[idx.count] || 0) : 0,
    };
  }).filter((t) => t.tag && t.slug);
}

/* ────────────────── 读语料并建索引 ────────────────── */

function readCorpus(file) {
  if (!fs.existsSync(file)) throw new Error('语料不存在: ' + file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : raw.items;
}

function qualityOk(it) {
  if (!it.q || it.q.length < 14 || it.q.length > 180) return false;
  if (!Array.isArray(it.o) || it.o.length < 3 || it.o.length > 5) return false;
  if (it.o.some((o) => !o || o.length > 64)) return false;
  if (!it.e || it.e.length < 34) return false;
  const seen = new Set(it.o.map(norm));
  if (seen.size !== it.o.length) return false;
  // 纯「以上都对」类选项价值低，剔除
  if (it.o.some((o) => /^(all|none) of the above/i.test(o))) return false;
  return true;
}

const STOP = new Set(['the', 'and', 'for', 'are', 'was', 'were', 'what', 'which', 'who', 'whom',
  'does', 'did', 'this', 'that', 'these', 'those', 'from', 'with', 'its', 'his', 'her', 'their',
  'has', 'have', 'had', 'into', 'about', 'following', 'called', 'known', 'would', 'could', 'should',
  'you', 'your', 'can', 'may', 'most', 'more', 'than', 'been', 'also', 'when', 'where', 'why', 'how']);

function tokens(s) {
  return new Set(
    String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => (w.length > 4 && /(?:es|s)$/.test(w) ? w.replace(/(?:es|s)$/, '') : w))
  );
}

/* 用「包含度」而不是 Jaccard：
   题库里的同义重复通常是「短句被扩写成长句」，长度差让 Jaccard 掉到
   0.5 以下反而漏掉，包含度（交/较短者）能稳定抓住。
   两条题目词集都少于 3 个实词时不作判定，避免误杀。 */
function overlap(a, b) {
  if (a.size < 3 || b.size < 3) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

/* 同页去重：题库里有大量「换个说法问同一件事」的题
   （例：What does the acronym 'HTTP' stand for in web addresses? /
        What does 'HTTP' stand for in a web address?）
   精确去重抓不到，必须按词集相似度再筛一遍，否则一页 15 题里
   会出现两三条一模一样的题，用户第一眼就看出是灌水。 */
const DUP_SIM = 0.72;

/* ────────────────── 选篇：难度配比 + 确定性洗牌 ────────────────── */

/* 选项洗牌（确定性）
   语料里正确答案压倒性地落在第 0/1 位——不洗牌的话「永远点第一个」能拿高分，
   区分度归零。种子取题干哈希，保证同一页重跑字节一致。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleOptions(q) {
  const rnd = mulberry32(fnv1a(q.q));
  const idx = q.o.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return { ...q, o: idx.map((i) => q.o[i]), c: idx.indexOf(q.c) };
}

function selectQuestions(tag, pool, n) {
  const seen = new Set();
  const cands = [];
  for (const it of pool) {
    if (!qualityOk(it)) continue;
    const k = norm(it.q);
    if (seen.has(k)) continue;
    seen.add(k);
    cands.push(it);
  }
  const hashed = cands.slice().sort((a, b) => fnv1a(a.qid + '|' + tag) - fnv1a(b.qid + '|' + tag));

  // 难度轮转排序：easy→medium→hard 循环。贪心挑选时天然得到接近 1:1:1
  // 的配比，比「先按配额切三段再拼」稳——后者一撞去重就会失衡。
  const bucket = { easy: [], medium: [], hard: [], other: [] };
  for (const it of hashed) {
    const d = String(it.d || '').toLowerCase();
    (bucket[d] || bucket.other).push(it);
  }
  const order = [];
  const lanes = [bucket.easy, bucket.medium, bucket.hard];
  for (let r = 0; ; r++) {
    let any = false;
    for (const lane of lanes) {
      if (lane[r]) { order.push(lane[r]); any = true; }
    }
    if (!any) break;
  }
  order.push(...bucket.other);

  // 贪心铺开：优先挑「和已选题几乎没有共同实词」的题，阈值逐级放宽。
  // 这解决的是另一种灌水感——15 题全在问 HTTP/HTTPS/TLS 哪个是协议，
  // 精确去重抓不到，但人一眼就看出来重复。
  const kept = [];
  const keptTokens = [];
  const take = (limit, thresh) => {
    for (const it of order) {
      if (kept.length >= limit) return;
      if (kept.includes(it)) continue;
      const tk = tokens(it.q);
      if (keptTokens.some((t) => overlap(tk, t) >= thresh)) continue;
      kept.push(it);
      keptTokens.push(tk);
    }
  };
  // 只放宽到「同义重复」这条线为止，不为了凑满 15 题塞重复题。
  // 题库小的 tag 允许出 10~14 题的页面——宁可短，不要一眼看穿的灌水。
  for (const th of [0.45, 0.6, DUP_SIM]) {
    take(n, th);
    if (kept.length >= n) break;
  }

  // 页内按 easy → medium → hard 排，让题目从易到难爬坡
  const rank = { easy: 0, medium: 1, hard: 2 };
  kept.sort((a, b) => (rank[String(a.d).toLowerCase()] ?? 1.5) - (rank[String(b.d).toLowerCase()] ?? 1.5));
  return kept.slice(0, n).map(shuffleOptions);
}

/* ────────────────── 文案 ────────────────── */

function introVariants(c) {
  const { Tag, tag, n, k, easy, med, hard, co } = c;
  const kw = word(k);
  return [
    `${Tag} is one of the deeper shelves in the MemoryDuel question bank — ${n.toLocaleString('en-US')} questions are tagged with it. The ${kw} below are a cross-section: ${easy} easy, ${med} medium, ${hard} hard. Answer them in order and you get a score plus the reason behind every answer.`,
    `${kw.charAt(0).toUpperCase() + kw.slice(1)} ${tag} questions, pulled from ${n.toLocaleString('en-US')} in the bank. No signup, no timer, nothing to install. Play straight through, or jump to the answer key below and read it like a study sheet — both are one scroll away.`,
    `A ${tag} quiz with the answers already written out. We took ${n.toLocaleString('en-US')} tagged questions and cut them down to ${kw} that cover the range: the definitions, the ones people argue about, and a couple that only land if you were actually paying attention.`,
    `How well do you know ${tag}? ${kw.charAt(0).toUpperCase() + kw.slice(1)} questions, drawn from a bank of ${n.toLocaleString('en-US')}, scored on the spot. Every answer comes with a short explanation, so a wrong guess still leaves you with something.`,
    `A working slice of the ${tag} shelf: ${n.toLocaleString('en-US')} questions exist, ${kw} made the cut. They run ${easy} easy, ${med} medium and ${hard} hard, so the set ramps instead of opening on the hardest thing in the bank.`,
  ];
}

function coLine(c) {
  const { co } = c;
  if (co.length < 2) return '';
  const list = co.slice(0, 3).map((t) => t.tag).join(', ').replace(/, ([^,]*)$/, ' and $1');
  return `Closest neighbours in the bank: ${list}. Questions here overlap with them heavily, so a strong score on ${c.tag} usually carries over.`;
}

const BANK_LINES = [
  'Every question is tagged by subject and rated easy, medium or hard before it goes live. The same pool feeds the live duels and the daily challenge, so what you miss here is worth knowing there.',
  'The bank is shared across the site: the questions on this page come from the same pool that powers 1v1 duels and the daily challenge. Nothing here is written off to the side for a search engine.',
];

function descVariants(c) {
  const { Tag, tag, n, k } = c;
  const kw = word(k);
  return [
    `${kw.charAt(0).toUpperCase() + kw.slice(1)} ${tag} questions with answers and explanations, drawn from ${n.toLocaleString('en-US')} in the MemoryDuel bank. Free, no signup.`,
    `A free ${tag} quiz: ${kw} questions, instant scoring, and every answer explained. Part of a ${n.toLocaleString('en-US')}-question ${tag} bank.`,
    `Test yourself on ${Tag} — ${kw} questions with the correct answer and a one-line explanation for each. Play in the browser, no account needed.`,
  ];
}

/* ────────────────── 页面渲染 ────────────────── */

function renderPage(t, qs, rel, copy) {
  const n = t.actual;
  const k = qs.length;
  const easy = qs.filter((q) => String(q.d).toLowerCase() === 'easy').length;
  const hard = qs.filter((q) => String(q.d).toLowerCase() === 'hard').length;
  const med = k - easy - hard;

  const c = { Tag: t.tag.replace(/\b\w/g, (m) => m.toUpperCase()), tag: t.tag, n, k, easy, med, hard, co: t.co || [] };
  const seed = fnv1a(t.slug);

  const title = (copy && copy.title) || `${c.Tag} Quiz — ${k} Questions with Answers | MemoryDuel`;
  const h1 = (copy && copy.h1) || `${c.Tag} Quiz`;
  const desc = (copy && copy.desc) || descVariants(c)[seed % 3];

  const intro = (copy && copy.intro) || [introVariants(c)[seed % 5], coLine(c), BANK_LINES[seed % 2]].filter(Boolean);

  const url = `${SITE}/quiz/${t.slug}/`;

  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Quiz',
        name: `${c.Tag} Quiz`,
        description: desc,
        url,
        inLanguage: 'en',
        about: { '@type': 'Thing', name: c.Tag },
        isPartOf: { '@type': 'WebSite', name: 'MemoryDuel', url: SITE + '/' },
        numberOfQuestions: k,
        educationalUse: 'self assessment',
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
          { '@type': 'ListItem', position: 2, name: 'Quizzes', item: SITE + '/quiz/' },
          { '@type': 'ListItem', position: 3, name: `${c.Tag} Quiz`, item: url },
        ],
      },
    ],
  };

  const data = { t: c.Tag, q: qs.map((q) => [q.q, q.o, q.c, q.e]) };
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, ' ');

  const keyItems = qs.map((q) => {
    const ans = q.o[q.c];
    return `      <li>
        <p class="qz-kq">${esc(q.q)}</p>
        <p class="qz-ka">Answer: <b>${esc(ans)}</b></p>
        ${q.e ? `<p class="qz-ke">${esc(q.e)}</p>` : ''}
      </li>`;
  }).join('\n');

  const relItems = rel.map((r) =>
    `        <li><a href="/quiz/${r.slug}/">${esc(r.tag)}<span class="n">${r.actual.toLocaleString('en-US')}</span></a></li>`
  ).join('\n');

  const diffChips = [
    easy ? `${easy} easy` : '',
    med ? `${med} medium` : '',
    hard ? `${hard} hard` : '',
  ].filter(Boolean).join(' · ');

  return `<!DOCTYPE html>
<html lang="en" data-site="memory">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#F4F5F9">
  <script>(function(){try{var t=localStorage.getItem('md-theme2');if(t==='dark'||(t!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.setAttribute('data-theme','dark');var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content','#12131F');}}catch(e){}})();</script>
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="MemoryDuel">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:image" content="${SITE}/og-default.jpg">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  <link rel="icon" type="image/svg+xml" href="/assets/img/favicon.svg">
  <link rel="alternate" hreflang="en" href="${url}">
  <link rel="alternate" hreflang="x-default" href="${url}">
  <link rel="stylesheet" href="/css/shared/tokens.css?v=md-p3">
  <link rel="stylesheet" href="/quiz/quiz.css?v=qz1">
  <script type="application/ld+json">${JSON.stringify(ld)}</script>
  <script>window.__GA4_ID__="G-2YY4FC8G44";</script>
  <link rel="stylesheet" href="/shared/consent.css?v=ph0-1">
  <link rel="stylesheet" href="/css/consent-md.css?v=md1">
  <script src="/shared/analytics.js?v=ph0-1" defer></script>
</head>
<body>

<nav class="qz-nav">
  <a class="qz-logo" href="/"><span class="mk"></span>MemoryDuel</a>
  <span class="sp"></span>
  <a class="qz-navlink" href="/quiz/">All quizzes</a>
</nav>

<main class="qz-wrap">
  <p class="qz-crumb"><a href="/">Home</a> / <a href="/quiz/">Quizzes</a> / ${esc(c.Tag)}</p>

  <header class="qz-hero">
    <p class="qz-eyebrow">${esc(t.cat || 'knowledge')} quiz</p>
    <h1>${esc(h1)}</h1>
${intro.map((p) => `    <p class="qz-lead">${/<\/?[a-z]/i.test(p) ? p : esc(p)}</p>`).join('\n')}
    <ul class="qz-stats">
      <li>${n.toLocaleString('en-US')} questions in this bank</li>
      <li>${word(k).replace(/^./, (m) => m.toUpperCase())} in this quiz</li>
      <li>${diffChips || 'mixed difficulty'}</li>
    </ul>
  </header>

  <section class="qz-card" id="play">
    <h2>Take the ${esc(t.tag)} quiz</h2>
    <p class="qz-note">Tap an answer to see the explanation. Number keys or A–D work too.</p>
    <div id="qz-app">
      <p class="qz-note">The interactive version needs JavaScript. The full answer key is a few lines below.</p>
    </div>
  </section>

  <section class="qz-card" id="answers">
    <h2>Answer key</h2>
    <p class="qz-note">All ${word(k)} questions above, with the correct answer and the reasoning.</p>
    <ol class="qz-key">
${keyItems}
    </ol>
  </section>

  <section class="qz-card">
    <h2>More quizzes like this</h2>
    <p class="qz-note">These shelves overlap with ${esc(c.tag)} most often.</p>
    <ul class="qz-rel">
${relItems}
    </ul>
    <div class="qz-actions">
      <a class="qz-btn" href="/games/knowledge-duel/lobby/">Play a live duel</a>
      <a class="qz-btn ghost" href="/quiz/">Browse all ${t.totalAll} quizzes</a>
    </div>
  </section>
</main>

<footer class="qz-foot">
  MemoryDuel · <a href="/">home</a> · <a href="/quiz/">quizzes</a> · <a href="/daily/">daily challenge</a> · <a href="/about/">about</a>
</footer>

<script type="application/json" id="qz-data">${dataJson}</script>
<script src="/quiz/quiz.js?v=qz1" defer></script>
</body>
</html>
`;
}

/* ────────────────── 总览页 ────────────────── */

function renderHub(topics, extra = 0) {
  // extra = 商业意图页数量（它们不在 topics 里，但算总数、算文案）
  const totalPages = topics.length + extra;
  const byCat = new Map();
  for (const t of topics) {
    const k = t.cat || 'other';
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(t);
  }
  const order = ['general', 'science', 'tech', 'history', 'arts', 'games', 'nature', 'other'];
  const cats = [...byCat.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const groups = cats.map((cat) => {
    const items = byCat.get(cat).sort((a, b) => b.actual - a.actual);
    return `  <section class="qz-group">
    <h2>${esc(cat.replace(/\b\w/g, (m) => m.toUpperCase()))}</h2>
    <ul class="qz-tags">
${items.map((t) => `      <li><a href="/quiz/${t.slug}/">${esc(t.tag)}<span class="n">${t.actual.toLocaleString('en-US')}</span></a></li>`).join('\n')}
    </ul>
  </section>`;
  }).join('\n');

  const totalQ = topics.reduce((s, t) => s + t.actual, 0);
  const url = SITE + '/quiz/';
  const desc = `Browse ${totalPages} topic and featured quizzes built from the MemoryDuel question bank — ${totalQ.toLocaleString('en-US')} questions in total, each with answers and explanations.`;

  return `<!DOCTYPE html>
<html lang="en" data-site="memory">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#F4F5F9">
  <script>(function(){try{var t=localStorage.getItem('md-theme2');if(t==='dark'||(t!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.setAttribute('data-theme','dark');var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content','#12131F');}}catch(e){}})();</script>
  <title>Topic Quizzes — ${totalPages} Subjects with Answers | MemoryDuel</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="MemoryDuel">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="Topic Quizzes — MemoryDuel">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:image" content="${SITE}/og-default.jpg">
  <link rel="icon" type="image/svg+xml" href="/assets/img/favicon.svg">
  <link rel="stylesheet" href="/css/shared/tokens.css?v=md-p3">
  <link rel="stylesheet" href="/quiz/quiz.css?v=qz1">
  <script>window.__GA4_ID__="G-2YY4FC8G44";</script>
  <link rel="stylesheet" href="/shared/consent.css?v=ph0-1">
  <link rel="stylesheet" href="/css/consent-md.css?v=md1">
  <script src="/shared/analytics.js?v=ph0-1" defer></script>
</head>
<body>

<nav class="qz-nav">
  <a class="qz-logo" href="/"><span class="mk"></span>MemoryDuel</a>
  <span class="sp"></span>
  <a class="qz-navlink" href="/daily/">Daily challenge</a>
</nav>

<main class="qz-wrap">
  <p class="qz-crumb"><a href="/">Home</a> / Quizzes</p>

  <header class="qz-hero">
    <p class="qz-eyebrow">question bank</p>
    <h1>Topic Quizzes</h1>
    <p class="qz-lead">${totalPages} quizzes, ${totalQ.toLocaleString('en-US')} questions, every answer explained. Pick a shelf and start — no account, no timer unless you want one.</p>
    <p class="qz-lead">Each quiz pulls ${word(PER_PAGE)} questions out of the full bank for that topic, so you can retake one and get a different set. The ones you miss tell you which neighbour topic to try next.</p>
    <ul class="qz-stats">
      <li>${totalPages} quizzes</li>
      <li>${totalQ.toLocaleString('en-US')} questions</li>
      <li>answers included</li>
    </ul>
  </header>

${groups}

  <section class="qz-card" style="margin-top:26px">
    <h2>How to use these</h2>
    <p class="qz-note">Read the answer key before you play and you'll learn faster; play first and you'll find out where you actually stand. Both are on every page, in that order.</p>
    <div class="qz-actions">
      <a class="qz-btn" href="/games/knowledge-duel/lobby/">Play a live duel</a>
      <a class="qz-btn ghost" href="/daily/">Today's challenge</a>
    </div>
  </section>
</main>

<footer class="qz-foot">
  MemoryDuel · <a href="/">home</a> · <a href="/daily/">daily challenge</a> · <a href="/about/">about</a> · <a href="/contact/">contact</a>
</footer>

<script src="/quiz/quiz.js?v=qz1" defer></script>
</body>
</html>
`;
}

/* ────────────────── 主流程 ────────────────── */

function main() {
  // 商业意图页（data/quiz-money/*.json）由 gen-money-pages.mjs 独占维护。
  // 这里必须跳过它们的 slug：本脚本会先清空 OUT 下所有子目录再重写，
  // 不跳过就会把手工页面连题目带 FAQ 一起删掉。
  const MONEY_DIR = path.join(ROOT, 'data/quiz-money');
  const MONEY = new Set(
    fs.existsSync(MONEY_DIR)
      ? fs.readdirSync(MONEY_DIR).filter((f) => f.endsWith('.json'))
          .map((f) => JSON.parse(fs.readFileSync(path.join(MONEY_DIR, f), 'utf8')).slug)
      : []
  );

  const topicsRaw = readTopics(TOPICS);
  const corpus = readCorpus(CORPUS);
  console.log(`[quiz] 主题 ${topicsRaw.length} 个 · 语料 ${corpus.length} 题`);

  // tag → 题目
  const byTag = new Map();
  for (const it of corpus) {
    for (const tg of it.t) {
      if (!byTag.has(tg)) byTag.set(tg, []);
      byTag.get(tg).push(it);
    }
  }

  // tag → 共同标签计数（用于「相关主题」）
  const co = new Map();
  for (const it of corpus) {
    if (it.t.length < 2) continue;
    for (const a of it.t) {
      let m = co.get(a);
      if (!m) { m = new Map(); co.set(a, m); }
      for (const b of it.t) if (b !== a) m.set(b, (m.get(b) || 0) + 1);
    }
  }

  // 第一轮：选题。必须排在「相关主题」之前 —— 只有真的出了页面的主题
  // 才能被内链指向，否则会留下指向未生成 slug 的死链（第一版踩过：
  // 4 个题量不足被跳过的主题仍出现在别人的「更多题库」里，7 条死链）。
  const topics = [];
  const dropped = [];
  for (const t of topicsRaw) {
    if (MONEY.has(t.slug)) continue; // 交给 gen-money-pages.mjs
    const pool = byTag.get(t.tag) || [];
    const qs = selectQuestions(t.tag, pool, PER_PAGE);
    if (qs.length < MIN_POOL) { dropped.push(`${t.tag}(${qs.length})`); continue; }
    topics.push({ ...t, actual: pool.filter(qualityOk).length, pool, qs });
  }
  console.log(`[quiz] 可生成 ${topics.length} 个（剔除 ${dropped.length} 个：题量/质量不足）`);

  const totalAll = topics.length;

  // 相关主题：共同标签权重 → 同分类兜底
  for (const t of topics) {
    const m = co.get(t.tag) || new Map();
    const scored = [...m.entries()]
      .filter(([tag]) => tag !== t.tag)
      .map(([tag, w]) => {
        const other = topics.find((x) => x.tag === tag);
        return other ? { ...other, w } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.w - a.w || b.actual - a.actual);
    const picked = scored.slice(0, 8);
    if (picked.length < 8) {
      const fill = topics
        .filter((x) => x.slug !== t.slug && x.cat === t.cat && !picked.some((p) => p.slug === x.slug))
        .sort((a, b) => b.actual - a.actual);
      for (const f of fill) {
        if (picked.length >= 8) break;
        picked.push(f);
      }
    }
    if (picked.length < 8) {
      const fill = topics
        .filter((x) => x.slug !== t.slug && !picked.some((p) => p.slug === x.slug))
        .sort((a, b) => b.actual - a.actual);
      for (const f of fill) {
        if (picked.length >= 8) break;
        picked.push(f);
      }
    }
    t.co = picked.map((p) => ({ tag: p.tag, slug: p.slug, actual: p.actual }));
  }

  // 复制覆盖（手写导语优先）
  let copyMap = {};
  if (fs.existsSync(COPY)) {
    try { copyMap = JSON.parse(fs.readFileSync(COPY, 'utf8')); } catch (e) { console.warn('[quiz] copy 文件解析失败，忽略:', e.message); }
  }

  // 清掉上一轮的产物，避免 slug 改名后留孤儿页
  fs.mkdirSync(OUT, { recursive: true });
  for (const e of fs.readdirSync(OUT, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== 'assets' && !MONEY.has(e.name)) {
      fs.rmSync(path.join(OUT, e.name), { recursive: true, force: true });
    }
  }

  let written = 0;
  for (const t of topics) {
    t.totalAll = totalAll;
    const html = renderPage(t, t.qs, t.co, copyMap[t.slug] || null);
    const dir = path.join(OUT, t.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    written++;
  }

  // 总览页。精选区（MONEY 块）由 gen-money-pages.mjs 维护，这里只负责搬回去：
  // 先摘出旧块，写完新 hub 再插回第一个分类区之前，避免每次重跑都丢。
  const hubFile = path.join(OUT, 'index.html');
  const MS = '<!-- MONEY:START -->';
  const ME = '<!-- MONEY:END -->';
  let moneyBlock = '';
  if (fs.existsSync(hubFile)) {
    const old = fs.readFileSync(hubFile, 'utf8');
    const i = old.indexOf(MS); const j = old.indexOf(ME);
    if (i >= 0 && j > i) moneyBlock = old.slice(i, j + ME.length);
  }
  let hubHtml = renderHub(topics, MONEY.size);
  if (moneyBlock) {
    const anchor = hubHtml.indexOf('<section class="qz-group">');
    if (anchor >= 0) hubHtml = hubHtml.slice(0, anchor) + moneyBlock + '\n\n  ' + hubHtml.slice(anchor);
  }
  fs.writeFileSync(hubFile, hubHtml);

  // 独立 sitemap：不动主 sitemap（那里有 /games/ 过滤逻辑，别去碰）
  const urls = [
    `  <url><loc>${SITE}/quiz/</loc><changefreq>weekly</changefreq><priority>0.9</priority><lastmod>${TODAY}</lastmod></url>`,
    ...topics.map((t) =>
      `  <url><loc>${SITE}/quiz/${t.slug}/</loc><changefreq>monthly</changefreq><priority>0.7</priority><lastmod>${TODAY}</lastmod></url>`
    ),
    // 商业意图页：不重生成，但 URL 必须留在 sitemap 里
    ...[...MONEY].map((slug) =>
      `  <url><loc>${SITE}/quiz/${slug}/</loc><changefreq>monthly</changefreq><priority>0.8</priority><lastmod>${TODAY}</lastmod></url>`
    ),
  ].join('\n');
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  fs.writeFileSync(path.join(OUT, '..', 'sitemap-quiz.xml'), sitemap);

  console.log(`[quiz] 写出 ${written} 个主题页 + 1 个总览页 + sitemap-quiz.xml → ${OUT}`);
  if (dropped.length) console.log(`[quiz] 未达标 tag: ${dropped.slice(0, 10).join(' ')}${dropped.length > 10 ? ' …' : ''}`);
}

main();
