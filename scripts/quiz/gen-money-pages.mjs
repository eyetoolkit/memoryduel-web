#!/usr/bin/env node
/**
 * gen-money-pages.mjs — 商业意图页生成器（2026-11-28）
 * ────────────────────────────────────────────────────────────────
 * 和 gen-quiz-pages.mjs 的分工：
 *
 *   gen-quiz-pages  → 「广度」：162 个主题页，纯算法选 15 题，语料里有什么写什么。
 *   gen-money-pages → 「精度」：8 个高搜索量关键词页，题目逐条手工挑/手工写，
 *                     配 FAQ + 覆盖范围清单 + 结构化数据。
 *
 * 设计约束：
 * 1. 题目来源二元：`picks`（语料 qid，人工挑过的）+ `manual`（手写）。
 *    两者都不进算法黑箱 —— 商业页上出现一道语料错题，比少一个页面贵得多。
 * 2. JSON-LD 必须和可见内容一致：numberOfQuestions 取实际渲染条数，FAQ 与 <dl> 同源。
 * 3. 幂等：重跑只覆盖它自己管的那 8 个 slug，不动主题页，不重复插 sitemap 条目。
 *
 * 用法：
 *   node scripts/quiz/gen-money-pages.mjs \
 *     --corpus /tmp/quiz-corpus.json \
 *     --spec   data/quiz-money \
 *     --out    public/quiz
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

const ROOT = process.cwd();
const CORPUS = path.resolve(ROOT, arg('corpus', '/tmp/quiz-corpus.json'));
const SPEC_DIR = path.resolve(ROOT, arg('spec', 'data/quiz-money'));
const OUT = path.resolve(ROOT, arg('out', 'public/quiz'));
const SITE = 'https://www.memoryduel.com';
const TODAY = new Date().toISOString().slice(0, 10);

/* ────────────────── 小工具 ────────────────── */

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// 语料里一部分选项带 “A. ” / “B) ” 前缀，商业页不能带出来
const cleanOpt = (s) => String(s).replace(/^\s*[A-Fa-f][.)]\s+/, '').trim();

const LANES = ['easy', 'medium', 'hard'];
const RANK = { easy: 0, medium: 1, hard: 2 };

/* 选项洗牌（确定性）
   ────────────────────────────────────────────────────────────
   语料里正确答案压倒性地落在第 0/1 位（实测第 22 题里 19 个是 A），
   不洗牌的话「永远选第一个」能拿 86 分，题目本身的区分度就废了。
   洗牌必须确定性：同一页重跑两次要字节一致，否则每次构建都是全站 diff。 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
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
  const o = idx.map((i) => q.o[i]);
  const c = idx.indexOf(q.c);
  return { ...q, o, c };
}

/* ────────────────── 校验 ────────────────── */

function validate(slug, qs) {
  const errs = [];
  const seen = new Set();
  qs.forEach((q, i) => {
    const where = `${slug}[${i}]`;
    if (!q.q || q.q.length < 14 || q.q.length > 190) errs.push(`${where} 题干长度异常`);
    if (!Array.isArray(q.o) || q.o.length < 3 || q.o.length > 5) errs.push(`${where} 选项数不是 3~5`);
    if (q.o.some((x) => String(x).length > 64)) errs.push(`${where} 有超长选项`);
    if (new Set(q.o.map((x) => String(x).toLowerCase().trim())).size !== q.o.length) errs.push(`${where} 选项重复`);
    if (!Number.isInteger(q.c) || q.c < 0 || q.c >= q.o.length) errs.push(`${where} 正确项下标越界`);
    if (!q.e || String(q.e).length < 34) errs.push(`${where} 解析过短（<34 字）`);
    const k = String(q.q).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(k)) errs.push(`${where} 题干重复：${String(q.q).slice(0, 40)}`);
    seen.add(k);
  });
  return errs;
}

/* ────────────────── 组装一页的题目 ────────────────── */

function buildQuestions(spec, byQid) {
  const out = [];
  const missing = [];

  for (const qid of spec.picks || []) {
    const src = byQid.get(qid);
    if (!src) { missing.push(qid); continue; }
    out.push({
      q: src.q,
      o: src.o.map(cleanOpt),
      c: src.c,
      e: src.e,
      d: String(src.d || 'medium').toLowerCase(),
      from: qid,
    });
  }

  (spec.manual || []).forEach(([q, o, c, e], i) => {
    out.push({
      q,
      o: o.map(cleanOpt),
      c,
      e,
      d: LANES[i % 3],
      from: 'manual',
    });
  });

  // 按难度分道轮转，避免「前 10 题全简单」或「后半段全是硬骨头」
  const buckets = { easy: [], medium: [], hard: [] };
  for (const q of out.map(shuffleOptions)) buckets[RANK[q.d] === undefined ? 'medium' : q.d].push(q);
  const ordered = [];
  for (let i = 0; ordered.length < out.length; i++) {
    let added = false;
    for (const lane of LANES) {
      if (buckets[lane][i]) { ordered.push(buckets[lane][i]); added = true; }
    }
    if (!added) break;
  }
  return { qs: ordered, missing };
}

/* ────────────────── 渲染 ────────────────── */

function render(spec, qs) {
  const url = `${SITE}/quiz/${spec.slug}/`;
  const n = qs.length;
  const easy = qs.filter((q) => q.d === 'easy').length;
  const hard = qs.filter((q) => q.d === 'hard').length;
  const med = n - easy - hard;

  const ldGraph = [
    {
      '@type': 'Quiz',
      name: spec.h1,
      description: spec.desc,
      url,
      inLanguage: 'en',
      about: { '@type': 'Thing', name: spec.about || spec.keyword },
      isPartOf: { '@type': 'WebSite', name: 'MemoryDuel', url: SITE + '/' },
      numberOfQuestions: n,
      educationalUse: 'self assessment',
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
        { '@type': 'ListItem', position: 2, name: 'Quizzes', item: SITE + '/quiz/' },
        { '@type': 'ListItem', position: 3, name: spec.h1, item: url },
      ],
    },
  ];

  if ((spec.faq || []).length) {
    ldGraph.push({
      '@type': 'FAQPage',
      mainEntity: spec.faq.map(([q, a]) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
    });
  }

  const data = { t: spec.h1, q: qs.map((q) => [q.q, q.o, q.c, q.e]) };
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, ' ');

  const keyItems = qs
    .map(
      (q) => `      <li>
        <p class="qz-kq">${esc(q.q)}</p>
        <p class="qz-ka">Answer: <b>${esc(q.o[q.c])}</b></p>
        <p class="qz-ke">${esc(q.e)}</p>
      </li>`
    )
    .join('\n');

  const coverItems = (spec.covers || []).map((c) => `      <li>${esc(c)}</li>`).join('\n');
  const faqItems = (spec.faq || [])
    .map(([q, a]) => `      <dt>${esc(q)}</dt>\n      <dd>${esc(a)}</dd>`)
    .join('\n');

  const relItems = (spec.related || [])
    .map((r) => `        <li><a href="/quiz/${r.slug}/">${esc(r.label)}<span class="n">${esc(r.note || '')}</span></a></li>`)
    .join('\n');

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
  <title>${esc(spec.title)}</title>
  <meta name="description" content="${esc(spec.desc)}">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="MemoryDuel">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="${esc(spec.title)}">
  <meta property="og:description" content="${esc(spec.desc)}">
  <meta property="og:image" content="${SITE}/og-default.jpg">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(spec.title)}">
  <meta name="twitter:description" content="${esc(spec.desc)}">
  <link rel="icon" type="image/svg+xml" href="/assets/img/favicon.svg">
  <link rel="alternate" hreflang="en" href="${url}">
  <link rel="alternate" hreflang="x-default" href="${url}">
  <link rel="stylesheet" href="/css/shared/tokens.css?v=md-p3">
  <link rel="stylesheet" href="/quiz/quiz.css?v=qz2">
  <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': ldGraph })}</script>
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
  <p class="qz-crumb"><a href="/">Home</a> / <a href="/quiz/">Quizzes</a> / ${esc(spec.crumb || spec.keyword)}</p>

  <header class="qz-hero">
    <p class="qz-eyebrow">${esc(spec.eyebrow || 'featured quiz')}</p>
    <h1>${esc(spec.h1)}</h1>
${spec.intro.map((p) => `    <p class="qz-lead">${esc(p)}</p>`).join('\n')}
    <ul class="qz-stats">
      <li>${n} questions</li>
      <li>every answer explained</li>
      <li>${diffChips || 'mixed difficulty'}</li>
    </ul>
    <ul class="qz-jump">
      <li><a href="#play">Play</a></li>
      <li><a href="#answers">Answer key</a></li>
      <li><a href="#covers">What it covers</a></li>
      <li><a href="#faq">FAQ</a></li>
    </ul>
  </header>

  <section class="qz-card" id="play">
    <h2>${esc(spec.playHeading || 'Take the quiz')}</h2>
    <p class="qz-note">Tap an answer to see the explanation. Number keys or A–D work too.</p>
    <div id="qz-app">
      <p class="qz-note">The interactive version needs JavaScript. The full answer key is a few lines below.</p>
    </div>
  </section>

  <section class="qz-card" id="answers">
    <h2>Answer key</h2>
    <p class="qz-note">All ${n} questions, with the correct answer and the reasoning.</p>
    <ol class="qz-key">
${keyItems}
    </ol>
  </section>

  <section class="qz-card" id="covers">
    <h2>What this quiz covers</h2>
${(spec.coversProse || []).map((p) => `    <p class="qz-note">${esc(p)}</p>`).join('\n')}
    <ul class="qz-covers">
${coverItems}
    </ul>
  </section>

  <section class="qz-card" id="faq">
    <h2>Frequently asked questions</h2>
    <dl class="qz-faq">
${faqItems}
    </dl>
  </section>

  <section class="qz-card">
    <h2>Keep going</h2>
    <ul class="qz-rel">
${relItems}
    </ul>
    <div class="qz-actions">
      <a class="qz-btn" href="/games/knowledge-duel/lobby/">Play a live duel</a>
      <a class="qz-btn ghost" href="/quiz/">Browse all quizzes</a>
    </div>
  </section>

  <p class="qz-meta">Last updated ${TODAY} · ${n} questions, all with explanations.</p>
</main>

<footer class="qz-foot">
  MemoryDuel · <a href="/">home</a> · <a href="/quiz/">quizzes</a> · <a href="/daily/">daily challenge</a> · <a href="/about/">about</a>
</footer>

<script type="application/json" id="qz-data">${dataJson}</script>
<script src="/quiz/quiz.js?v=qz2" defer></script>
</body>
</html>
`;
}

/* ────────────────── sitemap 合并 ────────────────── */

function mergeSitemap(slugs) {
  const p = path.join(OUT, '..', 'sitemap-quiz.xml');
  if (!fs.existsSync(p)) return '跳过（sitemap-quiz.xml 不存在）';
  let xml = fs.readFileSync(p, 'utf8');
  let added = 0;
  for (const slug of slugs) {
    const loc = `${SITE}/quiz/${slug}/`;
    if (xml.includes(`<loc>${loc}</loc>`)) continue;
    const entry = `  <url><loc>${loc}</loc><lastmod>${TODAY}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>\n`;
    xml = xml.replace(/\n<\/urlset>/, '\n' + entry + '</urlset>');
    added++;
  }
  fs.writeFileSync(p, xml);
  const total = (xml.match(/<loc>/g) || []).length;
  return `+${added} 条，现有 ${total} 条`;
}

/* ────────────────── hub 精选区 ────────────────── */

function patchHub(specs) {
  const p = path.join(OUT, 'index.html');
  if (!fs.existsSync(p)) return '跳过（hub 不存在）';
  let html = fs.readFileSync(p, 'utf8');
  const START = '<!-- MONEY:START -->';
  const END = '<!-- MONEY:END -->';

  const items = specs
    .map(
      (s) =>
        `      <li><a href="/quiz/${s.slug}/">${esc(s.hubLabel || s.keyword)}<span class="n">${s.count}</span></a></li>`
    )
    .join('\n');

  const block = `${START}
  <section class="qz-group">
    <h2>Featured quizzes</h2>
    <p class="qz-note">The eight that people search for by name. Longer than the topic pages — 18 to 24 questions each, hand-checked, with a full answer key and FAQ.</p>
    <ul class="qz-tags">
${items}
    </ul>
  </section>
${END}`;

  // 先按分类列表里的原条目摘掉，避免「精选区 + 分类区」重复列同一个链接
  let removed = 0;
  for (const s of specs) {
    const re = new RegExp('\\s*<li><a href="/quiz/' + s.slug + '/">[\\s\\S]*?</a></li>', 'g');
    const before = html.length;
    html = html.replace(re, '');
    if (html.length !== before) removed++;
  }

  if (html.includes(START) && html.includes(END)) {
    html = html.replace(new RegExp(START + '[\\s\\S]*?' + END), block);
  } else {
    // </header> 之后、第一个 qz-group 之前
    const anchor = html.indexOf('<section class="qz-group">');
    if (anchor < 0) return '跳过（找不到插入锚点）';
    html = html.slice(0, anchor) + block + '\n\n  ' + html.slice(anchor);
  }
  fs.writeFileSync(p, html);
  return `已写入 ${specs.length} 个精选条目（摘掉分类区重复 ${removed} 条）`;
}

/* ────────────────── 主流程 ────────────────── */

const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
const byQid = new Map(corpus.items.map((it) => [it.qid, it]));

const files = fs.readdirSync(SPEC_DIR).filter((f) => f.endsWith('.json')).sort();
// 展示顺序按搜索量排，不按字母排（字母序会把食物排在元素周期表前面）
const ORDER = ['us-states', 'capitals', 'us-presidents', 'world-war', 'periodic-table', 'harry-potter', 'human-body', 'food'];
const specs = files
  .map((f) => JSON.parse(fs.readFileSync(path.join(SPEC_DIR, f), 'utf8')))
  .sort((a, b) => {
    const ia = ORDER.indexOf(a.slug); const ib = ORDER.indexOf(b.slug);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

const problems = [];
const done = [];

for (const spec of specs) {
  const { qs, missing } = buildQuestions(spec, byQid);
  if (missing.length) problems.push(`${spec.slug}: 语料里找不到 ${missing.join(', ')}`);
  if (qs.length < 15) problems.push(`${spec.slug}: 只组装出 ${qs.length} 题（<15）`);
  const errs = validate(spec.slug, qs);
  if (errs.length) problems.push(...errs);

  const dir = path.join(OUT, spec.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), render(spec, qs));

  spec.count = qs.length;
  done.push({ slug: spec.slug, n: qs.length, picks: (spec.picks || []).length, manual: (spec.manual || []).length });
}

if (problems.length) {
  console.error('\n✗ 校验未通过，先修数据再发：');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}

const sm = mergeSitemap(done.map((d) => d.slug));
const hub = patchHub(specs);

console.log('\n生成完成：');
for (const d of done) {
  console.log(`  ${d.slug.padEnd(16)} ${String(d.n).padStart(2)} 题  (语料 ${d.picks} + 手写 ${d.manual})`);
}
console.log(`\nsitemap-quiz.xml：${sm}`);
console.log(`hub 精选区：${hub}`);
console.log('\n下一步：npm test → git push origin HEAD:main');
