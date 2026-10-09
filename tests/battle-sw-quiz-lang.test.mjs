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

for (const f of ['battle.html', 'index.html', 'public/train.html']) {
  const html = fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(html, /quiz-data\.js\?v=qd6/, `${f} must cache-bust qd6`);
}
console.log('✓ HTML refs quiz-data.js?v=qd6');

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
