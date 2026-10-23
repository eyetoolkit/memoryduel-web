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
// quiz-data.js 不得进 cache-first（它不带内容 hash —— sw.js 全文不应出现 quiz-data 字面量）
assert.doesNotMatch(sw, /quiz-data/);
console.log('✓ sw.js（线上注册版）V=mdusw-v1；导航 network-first；/api 不拦截；quiz-data 非 cache-first');

/* 修订（2026-10-23）：cache-bust 从「?v= query」升级为「文件名版本化」。
   原断言要求 quiz-data.js?v=<版本>，理由见下：
     - SW 侧：Cache.match 默认 ignoreSearch=false，换 ?v= 会生成新缓存条目 ✅
     - 但 **CF 边缘缓存键忽略 query**，?v= 对边缘无效 ❌
   故改为文件名版本化（quiz-data.v9.js）：新 URL 边缘必然回源，
   同时 SW 也必然是新条目。此断言改为要求「文件名带版本段」。
   顺带把新大厅页纳入同一契约（它同样依赖题库）。 */
for (const f of ['battle.html', 'index.html', 'public/train.html', 'games/knowledge-duel/lobby/index.html']) {
  const html = fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(html, /quiz-data\.v\d+\.js/, `${f} 必须引用带版本号的文件名 quiz-data.vN.js（?v= query 对 CF 边缘无效）`);
}
console.log('✓ 四页 HTML 均以文件名版本化 cache-bust quiz-data');

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
