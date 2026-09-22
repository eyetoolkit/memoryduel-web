// MemoryDuel 记忆对决 — Service Worker
// 加载三站共享 SW 策略（/shared/sw-helpers.js）

importScripts('/shared/sw-helpers.js');

TriSW.create({
  CACHE_VERSION: 'memoryduel-v9-authx',
  NETWORK_FIRST: [
    '/',
    '/train/'
  ],
  CACHE_FIRST: [
    '/manifest.webmanifest',
    '/css/shared/tokens.css',
    '/css/shared/sidebar.css',
    '/css/shared/components.css',
    '/css/shared/toast.css',
    '/js/sidebar.js',
    '/js/toast.js',
    '/assets/quiz-data.js'
  ],
  PRECACHE: [
    '/',
    '/manifest.webmanifest'
  ],
  PRECACHE_HTML: true
});