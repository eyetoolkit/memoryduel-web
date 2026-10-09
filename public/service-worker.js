// MemoryDuel 记忆对决 — Service Worker
// 加载三站共享 SW 策略（/shared/sw-helpers.js）

importScripts('/shared/sw-helpers.js');

TriSW.create({
  /* v10: battle/train HTML must be network-first. v9 cached stale train.html /
     battle that still pointed at quiz-data.js?v=qd4 (navigator-lang bug), so
     English UI kept loading Chinese questions after PR #7. */
  CACHE_VERSION: 'memoryduel-v10-quiz-lang',
  NETWORK_FIRST: [
    '/',
    '/train.html',
    '/train/',
    '/battle',
    '/battle/',
  ],
  CACHE_FIRST: [
    '/manifest.webmanifest',
    '/css/shared/tokens.css',
    '/css/shared/sidebar.css',
    '/css/shared/components.css',
    '/css/shared/toast.css',
    '/js/sidebar.js',
    '/js/toast.js',
    /* quiz-data.js intentionally NOT listed: ?v= cache-bust must hit network
       when HTML bumps the query; .js regex still cache-firsts by full Request
       URL (query included), so qd6 ≠ stale qd4. */
  ],
  PRECACHE: [
    '/',
    '/manifest.webmanifest'
  ],
  PRECACHE_HTML: true
});
