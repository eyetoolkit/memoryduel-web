/**
 * Battle/train path: 线上注册的 SW 必须对页面导航 network-first（quiz-data ?v= bumps 才生效）;
 * train getLang must honor ?lang= before i18n is ready.
 *
 * 2026-10-21 修订：原断言对象是 public/service-worker.js（TriSW 策略，经
 * importScripts('/shared/sw-helpers.js')）——该文件**从未被任何代码注册**
 * （public/js/sw-register.js:10 注册的是 /sw.js），测试保护的是死文件，
 * 线上真实策略零覆盖。现改为断言真正注册的 public/sw.js；
 * 死文件 service-worker.js + shared/sw-helpers.js 已删除。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
assert.match(sw, /const V = 'mdusw-v1'/);
// 页面导航 network-first：所有 HTML 导航（含 /battle、/train.html、/index.html）
// 永远优先网络，断网才回落缓存——比旧实现的逐页清单更通用
assert.match(sw, /req\.mode === 'navigate'/);
assert.match(sw, /caches\.match\('\/'\)/);
// /api/、/ws 绝不拦截（榜单/会话/教师端数据永远走网络）
assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/);
// quiz-data.js 不得进 cache-first（它不带内容 hash，靠 ?v= query 失效，
// 只能在 /assets|fonts/ 之外的 SWR 分支——sw.js 全文不应出现 quiz-data 字面量）
assert.doesNotMatch(sw, /quiz-data/);
console.log('✓ sw.js（线上注册版）V=mdusw-v1；导航 network-first；/api 不拦截；quiz-data 非 cache-first');

// 修订（2026-10-13）：原断言三页都锁 quiz-data.js?v=qd6，但 train.html 已随
// 「wrap 用 fetchLang 避免模块级 LANG 竞态」修复升到 qd8（commit 4c74e92），
// battle.html/index.html 仍是 qd6。缓存版本号本就允许各页独立，
// 真正的契约是「三页都必须带 ?v= query（否则 SW 拿到旧题库）」，故改为断言有版本号而非等于某个值。
for (const f of ['battle.html', 'index.html', 'public/train.html']) {
  const html = fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(html, /quiz-data\.js\?v=[A-Za-z0-9]+/, `${f} 必须 cache-bust quiz-data.js?v=<版本>`);
}
console.log('✓ 三页 HTML 均 cache-bust quiz-data.js?v=');

const trainHtml = fs.readFileSync(path.join(root, 'public/train.html'), 'utf8');
assert.match(trainHtml, /quiz-data\.js\?v=qd8/, 'train.html 应锁 qd8（fetchLang 竞态修复版本）');

const train = fs.readFileSync(path.join(root, 'public/train.html'), 'utf8');
assert.match(train, /Prefer URL \?lang=/);
assert.match(train, /bootBattle/);
assert.match(train, /_rawLang && q\._rawLang === lang/);
console.log('✓ train.html getLang prefers ?lang=; boots after DOMContentLoaded; raw-lang display');

const headers = fs.readFileSync(path.join(root, 'public/_headers'), 'utf8');
assert.match(headers, /\/train\.html/);
assert.match(headers, /\/battle/);
console.log('✓ _headers short-cache train + battle');

console.log('\nAll battle-sw-quiz-lang tests passed.');
