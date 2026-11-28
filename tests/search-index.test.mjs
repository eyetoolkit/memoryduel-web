/**
 * /search/ 索引与页面的一致性守卫（2026-11-28）
 * ────────────────────────────────────────────────────────────
 * 站内搜索是纯静态索引，最容易悄悄坏在「索引和页面不同步」：
 * 专题生成器重跑了、题目换了，index.json 还是旧的，搜索就答非所问，
 * 而页面本身不会报错。这里把三件事钉住：
 *   1. 索引覆盖磁盘上每一个 quiz 页，且没有指向不存在页面的条目；
 *   2. 索引里的标题 / 首题确实来自对应页面（不是过期的残留）；
 *   3. /search/ 页面本身是 noindex，且不得进入 sitemap。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const QUIZ = path.join(ROOT, 'public', 'quiz');
const INDEX = path.join(ROOT, 'public', 'search', 'index.json');
const PAGE = path.join(ROOT, 'public', 'search', 'index.html');

const raw = fs.readFileSync(INDEX, 'utf8');
const idx = JSON.parse(raw);
const docs = idx.docs || [];

function pageOf(slug) {
  return path.join(QUIZ, slug, 'index.html');
}

test('search: 索引存在且非空', () => {
  assert.ok(fs.existsSync(INDEX), 'public/search/index.json 不存在，跑 node scripts/quiz/gen-search-index.mjs');
  assert.ok(docs.length > 100, `只索引到 ${docs.length} 个页面，明显偏少`);
  assert.equal(idx.n, docs.length, 'n 与 docs 数量不一致');
});

test('search: 覆盖磁盘上的每个 quiz 页，且不指向不存在的页面', () => {
  const onDisk = fs
    .readdirSync(QUIZ, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'assets' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((s) => fs.existsSync(pageOf(s)))
    .sort();

  const inIndex = docs.map((d) => d.s).sort();

  const missing = onDisk.filter((s) => !inIndex.includes(s));
  assert.deepEqual(missing, [], `有页面没进索引: ${missing.join(', ')}`);

  const ghosts = inIndex.filter((s) => !onDisk.includes(s));
  assert.deepEqual(ghosts, [], `索引里有不存在的页面: ${ghosts.join(', ')}`);

  const dupes = inIndex.filter((s, i) => inIndex.indexOf(s) !== i);
  assert.deepEqual(dupes, [], `索引里 slug 重复: ${dupes.join(', ')}`);
});

test('search: 每条记录字段完整、URL 形状统一', () => {
  for (const d of docs) {
    assert.ok(d.s && /^[a-z0-9-]+$/.test(d.s), `slug 非法: ${d.s}`);
    assert.equal(d.u, '/quiz/' + d.s + '/', `${d.s} 的 URL 与 slug 不匹配`);
    assert.ok(d.t && d.t.length >= 2, `${d.s} 缺标题`);
    assert.ok(d.k && d.k.length >= 2, `${d.s} 缺分类`);
    assert.ok(Array.isArray(d.q) && d.q.length > 0, `${d.s} 没有收录任何题干`);
    assert.ok(d.q.length <= 24, `${d.s} 题干超过 24 条`);
    assert.ok(Array.isArray(d.a), `${d.s} 缺 a 字段`);
    assert.equal(d.a.length, d.q.length, `${d.s} 的 a 与 q 长度不一致（高亮会错位）`);
    for (const q of d.q) {
      assert.equal(typeof q, 'string');
      assert.ok(q.length > 0 && q.length <= 220, `${d.s} 题干长度异常: ${q.slice(0, 40)}`);
    }
    for (const a of d.a) assert.equal(typeof a, 'string');
    assert.ok(d.p === 0 || d.p === 1, `${d.s} 的 p 只能是 0/1`);
  }
});

test('search: 索引内容与页面现状一致（防过期）', () => {
  for (const d of docs) {
    const html = fs.readFileSync(pageOf(d.s), 'utf8');

    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    assert.ok(h1, `${d.s} 页面没有 h1`);
    const h1Text = h1[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    assert.equal(d.t, h1Text, `${d.s} 索引标题 ${JSON.stringify(d.t)} ≠ 页面 h1 ${JSON.stringify(h1Text)}`);

    const m = html.match(/<script type="application\/json" id="qz-data">([\s\S]*?)<\/script>/);
    assert.ok(m, `${d.s} 页面缺 qz-data`);
    const data = JSON.parse(m[1]);
    const first = String(data.q[0][0]).replace(/\s+/g, ' ').trim();
    assert.ok(
      d.q[0].startsWith(first.slice(0, 60)) || first.startsWith(d.q[0].slice(0, 60)),
      `${d.s} 首题与页面不一致 —— 索引过期了，重跑 gen-search-index.mjs`
    );

    // 答案必须是对应题目的正确选项，不是随便抓的一个
    const opt = data.q[0][1];
    const ci = data.q[0][2];
    const want = String(opt[ci]).replace(/\s+/g, ' ').trim();
    assert.ok(
      d.a[0] === want || d.a[0].startsWith(want.slice(0, 40)),
      `${d.s} 首题答案对不上：索引 ${JSON.stringify(d.a[0])} vs 页面 ${JSON.stringify(want)}`
    );
  }
});

test('search: 精选页标记与 data/quiz-money 对齐', () => {
  const moneyDir = path.join(ROOT, 'data', 'quiz-money');
  const money = fs
    .readdirSync(moneyDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(moneyDir, f), 'utf8')).slug)
    .sort();

  const featured = docs.filter((d) => d.p === 1).map((d) => d.s).sort();
  assert.deepEqual(featured, money, '索引里的精选页集合与 data/quiz-money 不一致');
});

test('search: 页面 noindex、不被 sitemap 收录', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  assert.match(html, /<meta name="robots" content="noindex/, '/search/ 必须 noindex');
  assert.match(html, /<form class="sq-form" action="\/search\/" method="get"/, '缺无 JS 可用的搜索表单');

  const headers = fs.readFileSync(path.join(ROOT, 'public', '_headers'), 'utf8');
  assert.match(headers, /\/search\/\*\s*\n\s*X-Robots-Tag: noindex/, '_headers 缺 /search/* 的 noindex');

  for (const f of ['sitemap.xml', 'sitemap-quiz.xml']) {
    const p = path.join(ROOT, 'public', f);
    if (!fs.existsSync(p)) continue;
    assert.ok(!fs.readFileSync(p, 'utf8').includes('/search/'), `${f} 不应收录 /search/`);
  }
});

test('search: 引用的静态资源都存在', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="(\/(?:css|js)\/[^"?]+)/g)].map((m) => m[1]);
  assert.ok(refs.length >= 4, '页面引用的静态资源数量异常');
  for (const r of new Set(refs)) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', r.replace(/^\//, ''))), `引用了不存在的资源 ${r}`);
  }
});
