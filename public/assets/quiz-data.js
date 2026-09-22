/* ═══════════════════════════════════════════════════════════════
   MemoryDuel API Bridge — 从 Worker /api/md/quiz/bundle 动态拉题
   - 串行加载 12 个分类, 带重试 (D1 并发容易失败)
   - 保留旧接口签名: Q.CATEGORIES, Q.QUESTIONS, Q.byCategory()
   - 降级: 全部失败时 QUESTIONS 仍为空, 但不会抛错
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var API = typeof window !== 'undefined' && window.API_BASE ? window.API_BASE : '';
  var LANG = (navigator.language || 'en').toLowerCase();
  if (LANG.startsWith('zh')) LANG = 'zh';
  else if (LANG.startsWith('es')) LANG = 'es';
  else if (LANG.startsWith('fr')) LANG = 'fr';
  else if (LANG.startsWith('de')) LANG = 'de';
  else LANG = 'en';

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
    var old = LANG;
    if (['en','zh','es','fr','de'].indexOf(l) >= 0) LANG = l;
    if (LANG !== old) {
      QUESTIONS.length = 0;
      loaded = null;
      loading = false;
      ensureLoaded().then(function () { window.dispatchEvent(new Event('memoryduel-ready')); });
    }
  }

  function wrap(apiQ, catId) {
    return {
      cn: catId,
      diff: ({ easy: 1, medium: 2, hard: 3 })[apiQ.difficulty] || 2,
      qn: { zh: apiQ.q, en: apiQ.q },
      op: { zh: apiQ.options.slice(), en: apiQ.options.slice() },
      ans: Number(apiQ.correct_index) || 0,
      ex: { zh: apiQ.explain || '', en: apiQ.explain || '' },
      _qid: apiQ.qid,
      _rawLang: LANG,
    };
  }

  function fetchBundle(catId, retries) {
    retries = retries || 2;
    var url = (API || '') + '/api/md/quiz/bundle?category=' + encodeURIComponent(catId) + '&lang=' + LANG + '&count=2000';

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
          console.warn('[MemoryDuel] fetchBundle failed for', catId, ':', err.message);
          return [];
        });
    }
    return attempt(0);
  }

  // 串行加载 — 避免 12 个并发请求把 D1 打垮
  async function ensureLoaded() {
    if (loaded) return loaded;
    loading = true;
    loaded = (async function () {
      var all = [];
      var successes = 0;
      for (var i = 0; i < CATEGORIES.length; i++) {
        var c = CATEGORIES[i];
        try {
          var arr = await fetchBundle(c.id, 2);
          all = all.concat(arr);
          if (arr.length > 0) successes++;
        } catch (e) { /* fetchBundle 内部已处理 */ }
      }
      QUESTIONS.length = 0;
      all.forEach(function (q) { QUESTIONS.push(q); });
      loading = false;
      return { total: all.length, categoriesOk: successes };
    })();
    return loaded;
  }

  ensureLoaded().then(function () {
    window.dispatchEvent(new Event('memoryduel-ready'));
  });

  window.MemoryDuelQuiz = {
    CATEGORIES: CATEGORIES,
    AI_NAMES: AI_NAMES,
    QUESTIONS: QUESTIONS,
    byCategory: byCategory,
    getLang: getLang,
    setLang: setLang,
    loaded: loaded,
    loading: function () { return loading; },
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