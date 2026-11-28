#!/usr/bin/env node
/**
 * fetch-corpus.mjs — 从 D1 (memoryduel-main) 拉取英文题库语料
 * ─────────────────────────────────────────────────────────────
 * 为什么要单独一步：
 *   /quiz/* 页面是「纯脚本 + 静态 HTML」生成的，生成器本身**不联网**。
 *   语料拉取需要 Cloudflare 凭据（global API key），只能在这里做一次，
 *   产出 corpus.json 交给生成器。生成器与凭据彻底解耦。
 *
 * 用法（需要在有 wrangler + CLOUDFLARE_API_KEY/EMAIL 的机器上跑）：
 *   set -a && . /opt/cf/secrets/.env && set +a
 *   node scripts/quiz/fetch-corpus.mjs --out /tmp/quiz-corpus.json
 *
 * 可选参数：
 *   --db      D1 binding 名（默认 MD_MAIN）
 *   --page    每页行数（默认 2000，太大容易撞 wrangler 输出上限）
 *   --config  指向含 d1_databases 的 wrangler.toml 所在目录（默认当前目录）
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

const DB = arg('db', 'MD_MAIN');
const PAGE = Number(arg('page', '2000'));
const OUT = arg('out', '/tmp/quiz-corpus.json');
const CWD = arg('config', process.cwd());

const COLS = 'id, qid, q, options_json, correct_index, explain_text, tags, master_cat, difficulty';

function query(sql) {
  const r = spawnSync(
    'wrangler',
    ['d1', 'execute', DB, '--remote', '--json', '--command', sql],
    { cwd: CWD, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  if (r.status !== 0) {
    throw new Error('wrangler 失败: ' + (r.stderr || '').slice(-800));
  }
  const txt = r.stdout;
  const start = txt.indexOf('[');
  if (start < 0) throw new Error('无法解析 wrangler 输出: ' + txt.slice(0, 400));
  const parsed = JSON.parse(txt.slice(start));
  const rows = parsed[0] && parsed[0].results;
  if (!Array.isArray(rows)) throw new Error('结果集为空或结构异常');
  return rows;
}

function total() {
  const rows = query(
    "SELECT COUNT(*) AS n FROM questions WHERE lang='en' AND status='verified'"
  );
  return rows[0].n;
}

const N = total();
console.log('[corpus] 英文已验证题量:', N);

const items = [];
for (let off = 0; off < N; off += PAGE) {
  const sql =
    `SELECT ${COLS} FROM questions ` +
    `WHERE lang='en' AND status='verified' ` +
    `ORDER BY id LIMIT ${PAGE} OFFSET ${off}`;
  const rows = query(sql);
  for (const r of rows) {
    let opts;
    try {
      opts = JSON.parse(r.options_json);
    } catch {
      continue;
    }
    if (!Array.isArray(opts) || opts.length < 2) continue;
    let tags;
    try {
      tags = JSON.parse(r.tags || '[]');
    } catch {
      tags = [];
    }
    const ci = Number(r.correct_index);
    if (!Number.isInteger(ci) || ci < 0 || ci >= opts.length) continue;
    items.push({
      id: r.id,
      qid: r.qid,
      q: String(r.q || '').trim(),
      o: opts.map((x) => String(x).trim()),
      c: ci,
      e: String(r.explain_text || '').trim(),
      t: Array.isArray(tags) ? tags : [],
      cat: r.master_cat || '',
      d: r.difficulty || '',
    });
  }
  console.log(`[corpus] ${Math.min(off + PAGE, N)}/${N} 累计可用 ${items.length}`);
}

fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), total: N, items }));
const mb = (fs.statSync(OUT).size / 1048576).toFixed(2);
console.log(`[corpus] 写出 ${OUT} · ${items.length} 题 · ${mb} MB`);
