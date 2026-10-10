/* ═══════════════════════════════════════════════════════════════
   MemoryDuel Service Worker —— 最小可用 PWA 策略
   ────────────────────────────────────────────────────────────────
   移植自 NumeriDuel 已上线的 sw.js（同一套策略）。

   原则（与 CF Pages + HTML max-age=0 must-revalidate 约束共存）：
   1. /api/、/ws 绝不拦截 —— 榜单/会话/教师端数据永远走网络
      （本站 API：/api/md/*、/api/teacher/* 均在 /api/ 下）
   2. /assets/（vite 带 hash、内容不变）与 /fonts/：cache-first
   3. 页面导航（HTML）：network-first —— 永远优先最新版，断网才用缓存
   4. 其余同源静态（/css/、/js/、/shared/、图标等）：stale-while-revalidate
   换版本：V 常量升级即弃旧缓存。

   ⚠️ 记录与成绩走 localStorage（无后端账号），离线可用性与 SW 无关；
      本 SW 只解决「断网时页面还能打开 + 静态资源秒开」。
   ═══════════════════════════════════════════════════════════════ */
const V = 'mdusw-v1';
const ASSET_RE = /^\/(assets|fonts)\//;
const ICON_RE = /^\/(favicon\.ico|apple-touch-icon\.png|icon-192\.png|icon-512\.png|icon-maskable-512\.png|manifest(\.[a-z]{2})?\.webmanifest)$/;

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/ws')) return;

  // 1) 带内容 hash 的构建产物与字体：cache-first（immutable）
  if (ASSET_RE.test(url.pathname) || ICON_RE.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(V).then((c) => c.put(req, clone));
        }
        return res;
      }))
    );
    return;
  }

  // 2) 页面导航：network-first，离线回落缓存
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(V).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
    );
    return;
  }

  // 3) 其余同源静态：stale-while-revalidate
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(V).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
