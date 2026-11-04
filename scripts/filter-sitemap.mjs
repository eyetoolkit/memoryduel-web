import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/**
 * 让首页 index.html 的 data-stage 成为唯一真相源：
 * 生产构建时，从 sitemap.xml 中移除未上线（非 live）游戏的条目，
 * 避免搜索引擎抓到 404 死链。测试构建保留全部条目。
 */
if (process.env.VITE_SHOW_BETA === '1') {
  console.log('[sitemap] 测试构建，保留全部条目');
  process.exit(0);
}

const html = await readFile(resolve(root, 'index.html'), 'utf8');
// 首页的游戏入口一律指向 `/games/<id>/lobby/`，所以这里必须同时接受
// 根目录型与 lobby 型 href，否则 live 集合恒为空、已上线游戏被误判为未上线
// 而从 sitemap 中移除（2026-10-17 修复，与 boardduel 同源逻辑对齐）。
const live = new Set(
  [...html.matchAll(/href="\/games\/([a-z0-9-]+)\/(?:lobby\/)?"\s+data-stage="live"/g)].map(
    (m) => m[1],
  ),
);

const sitemapPath = resolve(root, 'dist', 'sitemap.xml');
const xml = await readFile(sitemapPath, 'utf8');
const removed = [];

let out = xml.replace(/<url>[\s\S]*?<\/url>\s*/g, (block) => {
  const m = block.match(/<loc>[^<]*\/games\/([a-z0-9-]+)\//);
  if (m && !live.has(m[1])) {
    removed.push(m[1]);
    return '';
  }
  return block;
});

/* 2026-11-04：以前 lastmod 是静态快照（9-11 / 10-22），11-04 大改版后
   搜索引擎没有重抓信号。构建时统一写当天，让每次发布都能被及时重抓。
   注意这不是「假装每天更新」：只有真的产生新部署才会跑这个脚本。 */
const today = new Date().toISOString().slice(0, 10);
out = out.replace(/<lastmod>[\d-]+<\/lastmod>/g, `<lastmod>${today}</lastmod>`);

await writeFile(sitemapPath, out, 'utf8');
console.log('[sitemap] lastmod=' + today + (removed.length ? ' | 已移除未上线游戏: ' + removed.join(', ') : ' | 无需移除'));
