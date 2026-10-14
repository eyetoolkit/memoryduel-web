/**
 * CSS 注释完整性硬门（2026-10-14）
 * ────────────────────────────────────────────────────────────
 * 目的：在构建阶段拦住「注释未闭合 / 孤立闭合记号」这两类破坏，
 * 因为它们会让CSS 文件的后半段（含 :root 变量块）整段失效，
 * 而构建器零报错、页面不白屏，极难定位。
 *
 * 判据用状态机，不用简单计数：
 *   - 只有处在注释「外」时才识别起始记号；
 *   - 进入注释后忽略正文中出现的所有起始记号
 *     （例如注释里写文件路径 games/*.css 是完全合法的，
 *       简单计数会把它误判成新注释 → 误报）；
 *   - 注释中遇到结束记号即退出；
 *   - 注释外出现孤立的结束记号 → 报错；
 *   - 扫到文件末尾仍处���注释中 → 报错（这才是真正的吞规则事故）。
 *
 * 历史事故：daily-challenge.css 顶部大段注释的闭合记号被写坏，
 *   导致紧跟其后的 :root{--dc-primary:...} 及其后全部规则被当成注释。
 *   症状：CSS 文件里 grep 得到变量，浏览器 getPropertyValue 返回空，
 *   主按钮背景变透明，对比度掉到 1:1。已上线过一次才发现。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIRS = ['src/styles', 'src/pages', 'public/css', 'public/css/shared', 'games'];
const SLASH_STAR = '/' + '*';
const STAR_SLASH = '*' + '/';

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith('.css')) out.push(rel);
  }
  return out;
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

/** 状态机扫描：返回未闭合注释与孤立闭合记号 */
function scan(src) {
  const problems = [];
  let inComment = false;
  let commentStart = -1;
  let quote = null; // 引号内的内容不算记号

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        commentStart = -1;
        i++;
      }
      continue;
    }

    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '/' && next === '*') {
      inComment = true;
      commentStart = i;
      i++;
      continue;
    }

    if (ch === '*' && next === '/') {
      problems.push({ kind: 'stray-close', line: lineOf(src, i) });
      i++;
    }
  }

  if (inComment) {
    problems.push({ kind: 'unclosed', line: lineOf(src, commentStart) });
  }
  return problems;
}

const files = [...new Set(DIRS.flatMap((d) => walk(d)))];

if (files.length === 0) {
  console.error('✗ 没扫到任何 CSS 文件 —— 扫描目录配置有误，拒绝空跑通过。');
  process.exit(1);
}

let bad = 0;

for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const problems = scan(src);
  if (!problems.length) continue;
  bad++;
  console.error(`✗ ${f}`);
  for (const p of problems.slice(0, 6)) {
    if (p.kind === 'unclosed') {
      console.error(`  第 ${p.line} 行开始的注释从未闭合 —— 其后所有规则（含 :root 变量）都会失效`);
    } else {
      console.error(`  第 ${p.line} 行出现孤立的注释结束记号`);
    }
  }
  if (problems.length > 6) console.error(`  …… 另有 ${problems.length - 6} 处`);
}

if (bad) {
  console.error(`\n${bad} 个 CSS 文件注释结构异常 —— 已中止构建，避免把规则整块吞掉。`);
  process.exit(1);
}

console.log(`✓ CSS 注释结构：${files.length} 个文件全部正常（无未闭合注释 / 无孤立记号）`);