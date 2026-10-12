(function() {
/* ═══════════════════════════════════════════════════════════════
   每日题客户端模块
   ────────────────────────────────────────────────────────────────
   用途: 浏览器侧获取每日题 + 倒计时 + URL 检测
   依赖: 全局 fetch API (现代浏览器原生)
   API:
     getKey(date?)              → 'YYYYMMDD' (UTC 日期)
     fetch(game, dateKey?)      → { cards, solutions, ... } 或 null
     nextRollover()             → ms 到下一个 UTC 0 点
     getCurrentDailyUrl(game)   → 完整的今日 URL (?g=...)

   🔴 三站适配 (memoryduel P0-5, 2026-10-12)
   ────────────────────────────────────────────────────────────────
   本模块原先是为 numeri 站写的，只打 /api/daily/<game>。memoryduel 的
   每日挑战端点是 /api/md/daily/*（三站各自独立，路由不通用）。

   🔴 同时修掉一个「静默失败」反模式：原代码把所有 404 都当作
   「今日题尚未生成」返回 null。后果是——后端路由没部署 / 域名配错 /
   路径写错时，页面会安静地什么都不显示、零报错，线上极难排查。
   现区分为：
     · 404 + 响应体带 daily_not_found → 确实没有今天的题（正常情况）
     · 404 + 无该标记 / 其他状态码   → 路由或部署问题，抛错并 console.error
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ─── 站点判定：读 <html data-site>，决定用哪套端点 ─── */
function detectSite() {
  if (typeof document !== 'undefined') {
    const el = document.documentElement;
    const attr = el && el.getAttribute && el.getAttribute('data-site');
    if (attr) return attr;
  }
  if (typeof location !== 'undefined' && /(^|\.)memoryduel\./.test(location.hostname)) return 'memory';
  if (typeof location !== 'undefined' && /(^|\.)boardduel\./.test(location.hostname)) return 'board';
  return 'math';
}

const SITE = detectSite();

/* memoryduel 走 /api/md/daily/*，其余仍走 /api/daily/* */
const API_PREFIX = SITE === 'memory' ? '/api/md/daily' : '/api/daily';

const WS_BASE = (typeof window !== 'undefined' && window.MATHDUEL_WS_BASE)
  || (typeof location !== 'undefined' ? location.protocol + '//' + location.host : 'https://numeriduel.com');
const HTTP_BASE = WS_BASE.replace(/^wss?:/, '');

/* ─── 本地时区日期键 ───
   ⚠️ 仅用于「展示」当前是哪一天；真正的题目 seed 由服务端定，
   客户端不做任何参与随机。 */
function getKey(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/* ─── 到下一个本地 0 点的 ms ─── */
function nextRollover() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now.getTime();
}

/* ─── 内存缓存(避免重复请求)─── */
const cache = new Map(); // key: `${game}:${dateKey}` → Promise

/* ─── 判定 404 是「今天没题」还是「路由/部署有问题」───
   memoryduel 后端在无当日数据时返回 { error: { code:'daily_not_found' } }；
   而路由根本不存在时 Worker 返回的 404 响应体结构不同（或 HTML 404 页）。 */
function isGenuineNotFound(status, body) {
  if (status !== 404) return false;
  if (!body) return false;
  const code = body.error && (body.error.code || body.error) || body.code || body.error;
  return code === 'daily_not_found' || code === 'not_ready';
}

async function safeJson(r) {
  try { return await r.json(); } catch (_) { return null; }
}

/* ─── 主获取函数 ─── */
async function fetchDaily(game, dateKey) {
  dateKey = dateKey || getKey();
  const cacheKey = `${game}:${dateKey}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const url = `${HTTP_BASE}${API_PREFIX}/${encodeURIComponent(game)}?d=${dateKey}`;

  const promise = (async () => {
    let r;
    try {
      r = await fetch(url, { cache: 'no-store' });
    } catch (e) {
      // 网络层失败（离线 / DNS / CORS）——不是「今天没题」，必须报错
      const err = new Error(
        `[daily-challenge] 网络请求失败 ${url}: ${e && e.message}` +
        ` — 若站点为 ${SITE}，请确认后端 ${API_PREFIX} 路由可达`
      );
      console.error(err.message);
      throw err;
    }

    if (!r.ok) {
      const body = await safeJson(r);
      if (isGenuineNotFound(r.status, body)) {
        return null; // 今天确实还没出题（正常情况，静默返回）
      }
      // 🔴 非预期状态码：路由不存在 / 后端未部署 / 域名错配
      const err = new Error(
        `[daily-challenge] ${API_PREFIX} 返回 HTTP ${r.status}（${url}）` +
        ` — 若站点为 ${SITE}，请确认后端 ${API_PREFIX} 路由已部署`
      );
      console.error(err.message, body || '');
      throw err;
    }

    return await r.json();
  })();

  cache.set(cacheKey, promise);
  // 失败的 promise 不缓存，允许重试
  promise.catch(() => cache.delete(cacheKey));
  return promise;
}

/* ─── 预加载(可选,优化体验)─── */
async function prefetch(game, dateKey) {
  return fetchDaily(game, dateKey);
}

/* ─── URL 工具: 当前页 + ?g=&d= ─── */
function getCurrentDailyUrl(game, baseUrl) {
  const url = new URL(baseUrl || window.location.href);
  url.searchParams.set('g', game);
  url.searchParams.set('d', getKey());
  return url.toString();
}

/* ─── 解析当前 URL 的 ?g=&d= 参数 ─── */
function parseUrlParams() {
  if (typeof window === 'undefined') return { game: null, dateKey: null };
  const params = new URLSearchParams(window.location.search);
  const game = params.get('g');
  const dateKey = params.get('d');
  const referrer = params.get('r'); // 分享者 sessionId (W3.3 用)
  const medium = params.get('m');   // copy=从分享卡点入
  return { game, dateKey, referrer, medium };
}

/* ─── 倒计时格式化 ─── */
function formatCountdown(ms) {
  if (ms <= 0) return '已换题';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/* ─── 清除缓存(主要用于测试)─── */
function clearCache() {
  cache.clear();
}

/* ─── 浏览器全局 + Node 兼容 ─── */
if (typeof window !== 'undefined') {
  window.DailyChallenge = {
    getKey, fetch: fetchDaily, prefetch, nextRollover,
    getCurrentDailyUrl, parseUrlParams,
    formatCountdown, clearCache,
    fetch: fetchDaily,
    /* 三站适配诊断用：当前站点与实际使用的 API 前缀 */
    site: SITE, apiPrefix: API_PREFIX, httpBase: HTTP_BASE,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getKey, fetch: fetchDaily, prefetch, nextRollover,
    getCurrentDailyUrl, parseUrlParams,
    formatCountdown, clearCache,
    fetch: fetchDaily,
    /* 三站适配诊断用 */
    SITE, API_PREFIX, HTTP_BASE, detectSite, isGenuineNotFound,
  };
}
})();
