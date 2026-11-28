/**
 * 站内搜索索引生成器（2026-11-28）
 * ────────────────────────────────────────────────────────────
 * 目的：为 /search/ 生成一份纯静态检索索引，让用户在 166 个 quiz 页里
 * 直接搜到「哪个 quiz 能回答我这个问题」。
 *
 * 为什么不在页面里直接拉 D1：
 *   搜索要在输入时毫秒级响应，D1 一次查询 100~300ms，逐字符查询会打爆库；
 *   而题目文本本来就全部嵌在页面里（#qz-data），离线索引反而更准。
 *
 * 索引来源 = 已生成的 HTML 本身，不回头读 corpus：
 *   这样索引和线上页面永远一致，专题生成器改了题，重跑本脚本即同步。
 *
 * 输出：public/search/index.json
 *
 * 用法：node scripts/quiz/gen-search-index.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const QUIZ = path.join(ROOT, 'public', 'quiz');
const HUB = path.join(QUIZ, 'index.html');
const OUT = path.join(ROOT, 'public', 'search', 'index.json');

const MAX_Q = 24;   // 单页最多收录多少道题干（专题页 15 题，商业页最多 24 题）
const MAX_F = 6;    // FAQ 最多收录几条
const MAX_V = 8;    // "what this covers" 最多收录几条
const MAX_LEN = 220;

function strip(s) {
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s) {
  const t = strip(s);
  return t.length > MAX_LEN ? t.slice(0, MAX_LEN).replace(/\s\S*$/, '') : t;
}

/** 从 quiz 中心页解析 slug → 分类名（顺便识别 Featured 商业页） */
function readCategories() {
  const map = new Map();
  if (!fs.existsSync(HUB)) return map;
  const html = fs.readFileSync(HUB, 'utf8');
  const secRe = /<section class="qz-group">\s*<h2>([\s\S]*?)<\/h2>([\s\S]*?)<\/section>/g;
  let m;
  while ((m = secRe.exec(html))) {
    const cat = strip(m[1]);
    const linkRe = /href="\/quiz\/([a-z0-9-]+)\/"/g;
    let l;
    while ((l = linkRe.exec(m[2]))) {
      if (!map.has(l[1])) map.set(l[1], cat);
    }
  }
  return map;
}

function extractQuestions(html) {
  const m = html.match(/<script type="application\/json" id="qz-data">([\s\S]*?)<\/script>/);
  if (!m) return { q: [], a: [] };
  try {
    const data = JSON.parse(m[1]);
    const rows = (Array.isArray(data && data.q) ? data.q : []).slice(0, MAX_Q);
    const q = [];
    const a = [];
    for (const row of rows) {
      const stem = clip(row && row[0]);
      if (!stem) continue;
      q.push(stem);
      // 只收正确答案，不收四个选项：全量选项会把索引从 74KB 撑到 118KB(gz)，
      // 而「按干扰项反查」几乎是零意图。正确答案能覆盖 "saffron"、"mitochondria"
      // 这类「记得答案、不记得主题」的真实搜法。
      const opts = Array.isArray(row && row[1]) ? row[1] : [];
      const ci = typeof row[2] === 'number' ? row[2] : -1;
      a.push(ci >= 0 && opts[ci] != null ? clip(opts[ci]) : '');
    }
    return { q, a };
  } catch {
    return { q: [], a: [] };
  }
}

function extractFaq(html) {
  // FAQ 只在商业页存在；专题页没有 <dl class="qz-faq">
  const out = [];
  const dl = html.match(/<dl class="qz-faq">([\s\S]*?)<\/dl>/);
  if (!dl) return out;
  const re = /<dt>([\s\S]*?)<\/dt>/g;
  let m;
  while ((m = re.exec(dl[1]))) {
    const t = clip(m[1]);
    if (t) out.push(t);
    if (out.length >= MAX_F) break;
  }
  return out;
}

function extractCovers(html) {
  const out = [];
  const ul = html.match(/<ul class="qz-covers">([\s\S]*?)<\/ul>/);
  if (!ul) return out;
  const re = /<li>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(ul[1]))) {
    const t = clip(m[1]);
    if (t) out.push(t);
    if (out.length >= MAX_V) break;
  }
  return out;
}

function main() {
  if (!fs.existsSync(QUIZ)) {
    console.error('[search-index] 找不到 public/quiz/，先跑 gen-quiz-pages.mjs');
    process.exit(1);
  }

  const cats = readCategories();
  const slugs = fs
    .readdirSync(QUIZ, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'assets' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();

  const docs = [];
  const skipped = [];

  for (const slug of slugs) {
    const file = path.join(QUIZ, slug, 'index.html');
    if (!fs.existsSync(file)) {
      skipped.push(slug + ' (无 index.html)');
      continue;
    }
    const html = fs.readFileSync(file, 'utf8');

    const h1m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const descM = html.match(/<meta name="description" content="([\s\S]*?)">/);
    const title = h1m ? clip(h1m[1]) : '';
    const desc = descM ? clip(descM[1]) : '';
    if (!title) {
      skipped.push(slug + ' (无 h1)');
      continue;
    }

    const cat = cats.get(slug) || 'Other';
    const qa = extractQuestions(html);
    docs.push({
      s: slug,
      u: '/quiz/' + slug + '/',
      t: title,
      k: cat,
      d: desc,
      q: qa.q,
      a: qa.a,
      f: extractFaq(html),
      v: extractCovers(html),
      p: cat === 'Featured quizzes' ? 1 : 0,
    });
  }

  const payload = {
    v: 'se1',
    generated: new Date().toISOString().slice(0, 10),
    n: docs.length,
    docs,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));

  const bytes = fs.statSync(OUT).size;
  const totalQ = docs.reduce((s, d) => s + d.q.length, 0);
  const totalA = docs.reduce((s, d) => s + d.a.filter(Boolean).length, 0);
  console.log(
    `[search-index] ${docs.length} 个 quiz · ${totalQ} 条题干 · ${totalA} 条答案 · ${(bytes / 1024).toFixed(0)} KB → ${path.relative(ROOT, OUT)}`
  );
  if (skipped.length) console.log(`[search-index] 跳过 ${skipped.length} 个: ${skipped.slice(0, 6).join(', ')}`);
}

main();
