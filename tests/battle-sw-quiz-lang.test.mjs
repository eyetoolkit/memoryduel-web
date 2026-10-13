/**
 * Battle/train path: SW must network-first HTML so quiz-data ?v= bumps apply;
 * train getLang must honor ?lang= before i18n is ready.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sw = fs.readFileSync(path.join(root, 'public/service-worker.js'), 'utf8');
assert.match(sw, /CACHE_VERSION:\s*'memoryduel-v10-quiz-lang'/);
assert.match(sw, /\/train\.html/);
assert.match(sw, /\/battle/);
assert.doesNotMatch(sw, /CACHE_FIRST:[\s\S]*\/assets\/quiz-data\.js/);
console.log('✓ SW v10 network-first includes train.html + battle; quiz-data not cache-first listed');

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
