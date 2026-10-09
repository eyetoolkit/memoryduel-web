/* ═══════════════════════════════════════════════════════════════
   MemoryDuel API Bridge — 从 Worker /api/md/quiz/bundle 动态拉题
   - 串行加载 12 个分类, 带重试 (D1 并发容易失败)
   - 保留旧接口签名: Q.CATEGORIES, Q.QUESTIONS, Q.byCategory()
   - 降级: 全部失败时 QUESTIONS 仍为空, 但不会抛错
   - 题目语言必须跟随站内 UI 语言（与 i18n 优先级一致），禁止用
     navigator 覆盖已选的 English UI（否则中文浏览器会拿到中文题）。
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var API = typeof window !== 'undefined' && window.API_BASE ? window.API_BASE : '';
  /* 题目语言：与 public/i18n/i18n.js detectInitialLang 对齐
     优先级：?lang > /xx/ 路径 > <html lang> > window.i18n > localStorage > 默认 en
     刻意不用 navigator.language：i18n 默认 en，UI 英文时题库也必须英文。 */
  var QUIZ_LANGS = ['en', 'zh', 'ja', 'es', 'fr', 'de'];
  var DEFAULT_QUIZ_LANG = 'en';

  function normalizeLang(raw) {
    if (!raw) return '';
    var l = String(raw).split('-')[0].toLowerCase();
    return QUIZ_LANGS.indexOf(l) >= 0 ? l : '';
  }

  function langFromStorage() {
    try {
      var site = '';
      try {
        var ds = document.documentElement && document.documentElement.getAttribute('data-site');
        if (ds) site = String(ds);
      } catch (e0) {}
      var keys = [];
      if (site) keys.push(site + 'duel_lang'); // memoryduel_lang
      keys.push('lang');
      for (var i = 0; i < keys.length; i++) {
        var v = normalizeLang(localStorage.getItem(keys[i]));
        if (v) return v;
      }
    } catch (e) {}
    return '';
  }

  function detectQuizLang() {
    // Align with i18n.js detectInitialLang: ?lang > /xx/ > i18n > localStorage > default en.
    // Do NOT prefer static <html lang="en"> over localStorage — markup defaults to en
    // before i18n applies a stored zh/ja/... preference.
    // 1. URL ?lang=
    try {
      var fromUrl = new URLSearchParams(window.location.search).get('lang');
      var u = normalizeLang(fromUrl);
      if (u) return u;
    } catch (e1) {}
    // 2. Path prefix /xx/
    try {
      var m = (window.location.pathname || '').match(/^\/(zh|en|ja|es|fr|de)(\/|$)/);
      if (m) {
        var p = normalizeLang(m[1]);
        if (p) return p;
      }
    } catch (e2) {}
    // 3. window.i18n once currentLang is set (null during early dict fetch → skip)
    try {
      if (window.i18n && window.i18n.getLang) {
        var il = normalizeLang(window.i18n.getLang());
        if (il) return il;
      }
    } catch (e3) {}
    // 4. localStorage (same keys as i18n)
    var sl = langFromStorage();
    if (sl) return sl;
    // 5. <html lang> only if i18n already wrote a real preference (data-i18n-ready)
    try {
      var ready = document.documentElement && document.documentElement.getAttribute('data-i18n-ready');
      if (ready === 'true') {
        var hl = normalizeLang(document.documentElement.lang);
        if (hl) return hl;
      }
    } catch (e4) {}
    // 6. Site default — match i18n DEFAULT_LANG (en). Never navigator.language.
    return DEFAULT_QUIZ_LANG;
  }

  var LANG = detectQuizLang();
  var loadGen = 0;

  var CATEGORIES = [
    { id: 'science',  icon: '🔬', zh: '科学',   en: 'Science',   es: 'Ciencia',     fr: 'Sciences', de: 'Wissenschaft' },
    { id: 'history',  icon: '🏛️', zh: '历史',   en: 'History',   es: 'Historia',    fr: 'Histoire',  de: 'Geschichte' },
    { id: 'geography',icon: '🌍', zh: '地理',   en: 'Geography', es: 'Geografía',   fr: 'Géographie', de: 'Geographie' },
    { id: 'sports',   icon: '⚽', zh: '体育',   en: 'Sports',    es: 'Deportes',    fr: 'Sports',    de: 'Sport' },
    { id: 'movies',   icon: '🎬', zh: '影视',   en: 'Movies & TV', es: 'Películas', fr: 'Films',    de: 'Filme' },
    { id: 'tech',     icon: '💻', zh: '科技',   en: 'Technology', es: 'Tecnología',  fr: 'Technologie', de: 'Technologie' },
    { id: 'culture',  icon: '🎨', zh: '文化',   en: 'Culture',   es: 'Cultura',     fr: 'Culture',  de: 'Kultur' },
    { id: 'general',  icon: '🧠', zh: '常识',   en: 'General',   es: 'General',     fr: 'Général',   de: 'Allgemein' },
    { id: 'games',    icon: '🎮', zh: '游戏',   en: 'Games',     es: 'Juegos',      fr: 'Jeux',      de: 'Spiele' },
    { id: 'music',    icon: '🎵', zh: '音乐',   en: 'Music',     es: 'Música',      fr: 'Musique',   de: 'Musik' },
    { id: 'nature',   icon: '🌿', zh: '自然',   en: 'Nature',    es: 'Naturaleza',  fr: 'Nature',    de: 'Natur' },
    { id: 'arts',     icon: '🖼️', zh: '艺术',   en: 'Arts',      es: 'Arte',        fr: 'Arts',      de: 'Kunst' },
  ];

  var AI_NAMES = {
    en: ['Alex', 'Sam', 'Max', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley'],
    zh: ['小艾', '小智', '小明', '阿强', '阿飞', '小思', '小探', '快答'],
    es: ['Alex', 'Sam', 'Max', 'Jordan', 'Taylor', 'Morgan'],
    fr: ['Alex', 'Sam', 'Max', 'Jordan', 'Taylor', 'Morgan'],
    de: ['Alex', 'Sam', 'Max', 'Jordan', 'Taylor', 'Morgan'],
  };

  var QUESTIONS = [];
  var loaded = null;
  var loading = false;

  function byCategory(id) { return QUESTIONS.filter(function (q) { return q.cn === id; }); }

  function getLang() { return LANG; }
  function setLang(l) {
    var next = normalizeLang(l);
    if (!next) return;
    var old = LANG;
    LANG = next;
    if (LANG !== old) {
      QUESTIONS.length = 0;
      loaded = null;
      loading = false;
      loadGen++; // invalidate in-flight ensureLoaded from previous lang
      ensureLoaded().then(function (stats) {
        window.dispatchEvent(new CustomEvent('memoryduel-ready', { detail: stats || null }));
      });
    }
  }

  // 站内切换语言 / i18n 首屏就绪 → 题库跟随重载
  (function wireI18nFollow() {
    function follow(e) {
      try {
        var l = (e && e.detail && e.detail.lang)
          || (window.i18n && window.i18n.getLang && window.i18n.getLang())
          || detectQuizLang();
        if (l) setLang(l);
      } catch (err) {}
    }
    window.addEventListener('i18n:change', follow);
    window.addEventListener('i18n:ready', follow);
    window.addEventListener('language-changed', follow);
  })();

  /* 只把题面写入实际拉取语言槽位。旧逻辑把任意语言塞进 qn.en，
     导致 LANG=zh 拉取的中文题在 UI=en 时经 qn[lang]||qn.en 仍显示中文。 */
  function wrap(apiQ, catId) {
    var qn = {};
    var op = {};
    var ex = {};
    qn[LANG] = apiQ.q;
    op[LANG] = apiQ.options.slice();
    ex[LANG] = apiQ.explain || '';
    return {
      cn: catId,
      diff: ({ easy: 1, medium: 2, hard: 3 })[apiQ.difficulty] || 2,
      qn: qn,
      op: op,
      ans: Number(apiQ.correct_index) || 0,
      ex: ex,
      // raw fields for consumers that don't use qn[lang]
      q: apiQ.q,
      options: apiQ.options.slice(),
      explain: apiQ.explain || '',
      _qid: apiQ.qid,
      _rawLang: LANG,
    };
  }

  function fetchBundle(catId, retries) {
    retries = retries || 2;
    var url = (API || '') + '/api/md/quiz/bundle?category=' + encodeURIComponent(catId) + '&lang=' + LANG + '&count=100';

    function attempt(n) {
      return fetch(url, { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (j) {
          if (!j || !j.ok || !j.data) throw new Error('bad response');
          return (j.data.questions || []).map(function (q) { return wrap(q, catId); });
        })
        .catch(function (err) {
          if (n < retries) {
            // 指数退避: 200ms, 400ms, 800ms
            return new Promise(function (res) { setTimeout(function () { res(attempt(n + 1)); }, (n + 1) * 200); });
          }
          console.error('[MD] fetchBundle failed for', catId, ':', err && err.message);
          beaconClientError({
            source: 'quiz-data',
            kind: 'fetch_bundle_failed',
            category: catId,
            message: String((err && err.message) || 'fetch_failed').slice(0, 120),
            lang: LANG,
            path: (typeof location !== 'undefined' ? location.pathname : ''),
          });
          // Keep Array contract for train.html callers; stamp failure for ensureLoaded.
          var empty = [];
          empty.__error = true;
          empty.category = catId;
          empty.message = (err && err.message) || 'fetch_failed';
          return empty;
        });
    }
    return attempt(0);
  }

  var lastLoadError = null; // { total, categoriesOk, categoriesFailed, failedIds, message } | null

  /* P0-5: lightweight client error beacon → existing /api/md/track (MD_EVENTS).
     Prefer sendBeacon; fall back to fetch keepalive. Never blocks UI. */
  function beaconClientError(props) {
    try {
      var payload = JSON.stringify({
        events: [{
          event: 'client_error',
          sessionId: null,
          timestamp: new Date().toISOString(),
          props: props || {},
        }],
      });
      var url = (API || '') + '/api/md/track';
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
        return;
      }
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
        credentials: 'same-origin',
      }).catch(function () {});
    } catch (e) {
      console.error('[MD] client_error beacon failed', e && e.message);
    }
  }

  // 串行加载 — 避免 12 个并发请求把 D1 打垮
  async function ensureLoaded() {
    if (loaded) return loaded;
    loading = true;
    lastLoadError = null;
    var myGen = ++loadGen;
    loaded = (async function () {
      var all = [];
      var successes = 0;
      var failedIds = [];
      for (var i = 0; i < CATEGORIES.length; i++) {
        if (myGen !== loadGen) return null; // superseded by setLang
        var c = CATEGORIES[i];
        try {
          var arr = await fetchBundle(c.id, 2);
          if (myGen !== loadGen) return null;
          if (arr && arr.__error) {
            failedIds.push(c.id);
            continue;
          }
          all = all.concat(arr || []);
          if (arr && arr.length > 0) successes++;
        } catch (e) {
          failedIds.push(c.id);
          console.error('[MD] ensureLoaded category crash', c.id, e && e.message);
        }
      }
      if (myGen !== loadGen) return null;
      QUESTIONS.length = 0;
      all.forEach(function (q) { QUESTIONS.push(q); });
      loading = false;
      var stats = {
        total: all.length,
        categoriesOk: successes,
        categoriesFailed: failedIds.length,
        failedIds: failedIds,
        lang: LANG,
      };
      if (failedIds.length > 0 || all.length === 0) {
        lastLoadError = Object.assign({
          message: all.length === 0
            ? 'quiz_load_empty'
            : 'quiz_load_partial',
        }, stats);
        console.error('[MD] quiz load issue', lastLoadError);
        // Per-category beacons already fired from fetchBundle; emit one summary if total empty
        // (covers soft-empty: all 200 OK but 0 questions — no per-cat __error).
        if (all.length === 0) {
          beaconClientError({
            source: 'quiz-data',
            kind: lastLoadError.message,
            total: 0,
            categoriesOk: stats.categoriesOk,
            categoriesFailed: stats.categoriesFailed,
            failedIds: failedIds.slice(0, 12),
            lang: LANG,
            path: (typeof location !== 'undefined' ? location.pathname : ''),
          });
        }
      }
      return stats;
    })();
    return loaded;
  }

  ensureLoaded().then(function (stats) {
    window.dispatchEvent(new CustomEvent('memoryduel-ready', { detail: stats || null }));
  });

  window.MemoryDuelQuiz = {
    CATEGORIES: CATEGORIES,
    AI_NAMES: AI_NAMES,
    QUESTIONS: QUESTIONS,
    byCategory: byCategory,
    getLang: getLang,
    setLang: setLang,
    detectLang: detectQuizLang,
    loaded: loaded,
    loading: function () { return loading; },
    loadError: function () { return lastLoadError; },
    ensureLoaded: ensureLoaded,
    fetchBundle: fetchBundle,        // exposed for single-category fast-path
  };

  Object.defineProperty(window.MemoryDuelQuiz, 'ready', {
    get: function () { return !loading && QUESTIONS.length > 0; }
  });

  window.addEventListener('langchange', function (e) {
    var lang = (e && e.detail && e.detail.lang) || LANG;
    if (lang !== LANG) setLang(lang);
  });

  // 触发一个 sync 事件，告知页面 quiz-data.js 已加载（但题目可能仍在加载）
  window.dispatchEvent(new CustomEvent('memoryduel-quiz-ready'));

})();
