#!/usr/bin/env node
/**
 * 给 memoryduel 六语词典批量加键，并同步 dictVersion。
 *
 * 🔴 i18n 铁律（本地记忆）：
 *    memoryduel 没有 additions / replay 门禁，直接改 public/i18n/*.json 即可；
 *    真相源是 public/i18n/VERSION；
 *    改了词典必须**全站所有 html 的 dictVersion 同号**（只 bump 首页会让 build-gate 红）。
 *
 * 用法：node scripts/add-i18n-keys.mjs <keys.json>
 *   keys.json 形如：
 *   {
 *     "duel.submit": { "en": "Submit", "zh": "提交", "ja": "提出", "de": "Absenden", "fr": "Valider", "es": "Enviar" },
 *     "dc.num_submit": { ... }
 *   }
 *
 * 幂等：已存在且值相同的键跳过；值不同则以新值覆盖并报告。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N = path.join(ROOT, 'public', 'i18n');
const LANGS = ['en', 'zh', 'ja', 'de', 'fr', 'es'];

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/add-i18n-keys.mjs <keys.json>'); process.exit(1); }
const NEW = JSON.parse(fs.readFileSync(path.resolve(src), 'utf8'));

/* ── 1. 写词典 ── */
const report = [];
for (const lang of LANGS) {
  const f = path.join(I18N, `${lang}.json`);
  const dict = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const [key, vals] of Object.entries(NEW)) {
    const val = vals[lang] ?? vals.en;
    if (val === undefined) { report.push(`⚠️ ${lang} 缺 ${key}，回退 en`); continue; }
    const parts = key.split('.');
    let node = dict;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    const before = node[leaf];
    if (before === val) continue;
    node[leaf] = val;
    report.push(`${lang}.${key}: ${before === undefined ? '新增' : `覆盖 "…${String(before).slice(0, 24)}"`}`);
  }
  fs.writeFileSync(f, JSON.stringify(dict, null, 2) + '\n', 'utf8');
}

/* ── 2. VERSION +1 ── */
const vf = path.join(I18N, 'VERSION');
const oldV = Number(fs.readFileSync(vf, 'utf8').trim());
const newV = oldV + 1;
fs.writeFileSync(vf, String(newV) + '\n', 'utf8');

/* ── 3. 所有 html 的 dictVersion 同步 ── */
const HTML_RE = /dictVersion:\s*\d+/g;
const htmlFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', '_build-verify-20261029'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) htmlFiles.push(p);
  }
};
walk(ROOT);
let changed = 0;
for (const f of htmlFiles) {
  const s = fs.readFileSync(f, 'utf8');
  if (!HTML_RE.test(s)) continue;
  const out = s.replace(HTML_RE, `dictVersion:${newV}`);
  if (out !== s) { fs.writeFileSync(f, out, 'utf8'); changed++; }
}

console.log(`VERSION ${oldV} → ${newV}；html dictVersion 同步 ${changed} 个文件`);
console.log(report.length ? report.join('\n') : '（无新增，全部已存在且值相同）');
