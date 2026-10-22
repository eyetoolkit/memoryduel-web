/* ============================================================
   MemoryDuel · 全站侧栏 chrome 注入器 v1.0（2026-10-22）
   ------------------------------------------------------------
   目标：与 BoardDuel / NumeriDuel 的品牌侧栏视觉对齐
   （品牌字标 + Play now CTA + 主题切换 + 分组导航 + 语言切换 + 折叠 rail），
   由本注入器运行时注入，页面只需加 1 行：
     <script src="/js/chrome-mem.js?v=1" defer></script>

   设计取舍：
   - 自包含 CSS+DOM+逻辑（不进 Vite 构建、不依赖各页样式表），
     颜色全部走页面已有 CSS 变量（--paper/--card/--ink/--line/--orange-ink…），
     暗色由 html[data-theme="dark"] 令牌自然生效。
   - 主题切换直接读写 md-theme2 + data-theme（与 shared/theme.js 同语义），
     不依赖 theme.js 的 DOM 注入（它挂 .nav，本注入器把 .nav 隐藏）。
   - 旧 chrome 处理：首页顶栏 .nav / #navDrawer 由 body.mc-on 隐藏；
     游戏页 dc-top 保留（含 roundTag 功能件），仅视觉上成为内容区页头。
   - 桌面 ≥1024px：固定侧栏 + body padding-left 让位；« 折叠成 72px rail。
     移动 <1024px：浮动 burger + 抽屉 + overlay，Esc/overlay 关闭。
   - 语言：自包含六语字典，读 window.i18n → memoryduel_lang → lang → html.lang，
     监听 i18n:change 实时重绘（与 eco-home.mjs 同机制）。
   ============================================================ */
(function () {
  'use strict';
  if (window.__MC_CHROME__) return;
  window.__MC_CHROME__ = true;

  /* ─── 站点配置（游戏清单：新增游戏在此加一行） ─── */
  var GAMES = [
    { icon: '⚡', href: '/games/sequence-memory/', key: 'nav.seq' },
    { icon: '🔢', href: '/games/number-recall/',  key: 'nav.num' },
    { icon: '🎨', href: '/games/color-recall/',   key: 'nav.color' },
    { icon: '📝', href: '/games/word-recall/',    key: 'nav.word' },
    { icon: '🐒', href: '/games/chimp-test/',     key: 'nav.chimp' },
    { icon: '👻', href: '/games/emoji-ghost/',    key: 'nav.ghost' }
  ];
  var GAMES_FALLBACK = {
    'nav.seq': 'Sequence Memory', 'nav.num': 'Number Recall', 'nav.color': 'Color Recall',
    'nav.word': 'Word Recall', 'nav.chimp': 'Chimp Test', 'nav.ghost': 'Emoji Ghost'
  };

  /* ─── 六语字典（self-contained，不依赖站点 i18n.json） ─── */
  var DICT = {
    en: { play: 'Play now', home: 'Home', daily: 'Daily Challenge', games: 'All games', more: 'More',
          train: 'Solo Train', member: 'Membership', how: 'How to play', lang: 'English' },
    zh: { play: '开始游戏', home: '首页', daily: '每日挑战', games: '全部游戏', more: '更多',
          train: '单人训练', member: '会员中心', how: '玩法说明', lang: '简体中文' },
    ja: { play: 'プレイ', home: 'ホーム', daily: 'デイリー挑戦', games: 'ゲーム一覧', more: 'その他',
          train: 'ソロ訓練', member: 'メンバーシップ', how: '遊び方', lang: '日本語' },
    es: { play: 'Jugar', home: 'Inicio', daily: 'Reto diario', games: 'Juegos', more: 'Más',
          train: 'Entreno solo', member: 'Membresía', how: 'Cómo jugar', lang: 'Español' },
    fr: { play: 'Jouer', home: 'Accueil', daily: 'Défi du jour', games: 'Jeux', more: 'Plus',
          train: 'Entraînement', member: 'Abonnement', how: 'Comment jouer', lang: 'Français' },
    de: { play: 'Spielen', home: 'Start', daily: 'Tageschallenge', games: 'Spiele', more: 'Mehr',
          train: 'Solo-Training', member: 'Mitgliedschaft', how: 'Anleitung', lang: 'Deutsch' }
  };

  function t(key) {
    var d = DICT[currentLang()] || DICT.en;
    return d[key] || DICT.en[key] || key;
  }
  function gameName(g) {
    if (typeof window !== 'undefined' && window.t) {
      try { var v = window.t(g.key); if (v && v !== g.key) return v; } catch (e) {}
    }
    return GAMES_FALLBACK[g.key] || g.key;
  }

  /* ─── 语言（与 sidebar.js v2.2 同优先级链） ─── */
  function currentLang() {
    if (window.i18n && typeof window.i18n.getLang === 'function') {
      try { var l = window.i18n.getLang(); if (l) return String(l).split('-')[0]; } catch (e) {}
    }
    try {
      var v = localStorage.getItem('memoryduel_lang') || localStorage.getItem('lang');
      if (v && v.length >= 2) return v.split('-')[0];
    } catch (e) {}
    var hl = document.documentElement.lang || 'en';
    return hl.split('-')[0];
  }

  /* ─── 主题（与 shared/theme.js 同语义：md-theme2 + data-theme） ─── */
  function isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
  function setTheme(mode) {
    try { localStorage.setItem('md-theme2', mode); } catch (e) {}
    document.documentElement.setAttribute('data-theme', mode);
    var btn = document.querySelector('.mc-theme');
    if (btn) btn.textContent = mode === 'dark' ? '☀️' : '🌙';
  }
  function toggleTheme() { setTheme(isDark() ? 'light' : 'dark'); }

  /* ─── CSS ─── */
  var CSS = ''
    + ':root{--mc-w:236px;--mc-w-rail:72px}'
    + '.mc-sidebar{position:fixed;top:0;left:0;bottom:0;width:var(--mc-w);z-index:60;'
    + 'background:var(--card,#fff);border-right:1px solid var(--line,#EAD9C7);'
    + 'display:flex;flex-direction:column;padding:14px 12px;gap:4px;'
    + 'font-family:inherit;overflow-y:auto;overflow-x:hidden;transition:width .16s ease,transform .2s ease}'
    + 'body.mc-rail .mc-sidebar{width:var(--mc-w-rail)}'
    + '.mc-brand{display:flex;align-items:center;gap:8px;padding:4px 8px;font-weight:800;font-size:1.06rem;'
    + 'color:var(--ink,#1C1408);text-decoration:none;white-space:nowrap}'
    + '.mc-brand .mk{width:14px;height:14px;border-radius:4px;background:var(--orange,#EA580C);display:inline-block;flex:none}'
    + '.mc-brand b{color:var(--orange,#EA580C);font-weight:800}'
    + '.mc-toprow{display:flex;align-items:center;gap:8px;margin:6px 0 10px}'
    + '.mc-play{flex:1;display:block;text-align:center;background:var(--orange-ink,#C2410C);color:#fff!important;'
    + 'border:none;border-radius:12px;padding:9px 10px;font-weight:800;font-size:.9rem;cursor:pointer;'
    + 'text-decoration:none;white-space:nowrap;transition:transform .12s}'
    + '.mc-play:hover{transform:translateY(-1px)}'
    + '.mc-theme{flex:none;width:38px;height:38px;border-radius:11px;border:1px solid var(--line,#EAD9C7);'
    + 'background:var(--card,#fff);cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center}'
    + '.mc-group{font-size:.68rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;'
    + 'color:var(--mute,#6B5A45);padding:12px 8px 4px;white-space:nowrap}'
    + 'body.mc-rail .mc-group{visibility:hidden;height:8px;padding:0;overflow:hidden}'
    + '.mc-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;'
    + 'color:var(--ink,#1C1408);text-decoration:none;font-size:.9rem;font-weight:600;white-space:nowrap;'
    + 'opacity:.88;transition:background .12s}'
    + '.mc-item:hover{background:rgba(0,0,0,.045)}'
    + '.mc-item.active{background:rgba(234,88,12,.10);color:var(--orange-ink,#C2410C);opacity:1}'
    + '.mc-item .ico{width:20px;text-align:center;flex:none;font-size:1.02rem}'
    + 'body.mc-rail .mc-item span.lbl{display:none}'
    + '.mc-foot{margin-top:auto;padding:10px 8px 2px;display:flex;align-items:center;justify-content:space-between;gap:6px}'
    + 'body.mc-rail .mc-foot .lbl{display:none}'
    + '.mc-lang{border:1px solid var(--line,#EAD9C7);background:var(--card,#fff);color:var(--ink,#1C1408);'
    + 'border-radius:9px;padding:6px 8px;font-size:.78rem;font-weight:700;cursor:pointer;max-width:100%}'
    + '.mc-copy{font-size:.68rem;color:var(--mute,#6B5A45);opacity:.7;white-space:nowrap}'
    + '.mc-collapse{position:absolute;top:14px;right:-13px;width:26px;height:26px;border-radius:50%;'
    + 'border:1px solid var(--line,#EAD9C7);background:var(--card,#fff);color:var(--ink,#1C1408);'
    + 'cursor:pointer;font-size:1rem;line-height:1;font-weight:800;display:flex;align-items:center;justify-content:center;'
    + 'box-shadow:0 2px 8px rgba(60,30,10,.14);z-index:2}'
    + '/* dc-top 的返回链接与侧栏 Home 重复，chrome 激活时隐藏 */'
    + 'body.mc-on .dc-top .back{display:none!important}'
    + '/* theme.js 在无 .nav 页面会把空按钮挂 body 顶部，chrome 已自带主题切换 → 隐藏 */'
    + 'body.mc-on .md-theme{display:none!important}'
    + '/* 让位：桌面主内容整体右移 */'
    + '@media (min-width:1024px){'
    + 'body.mc-on{padding-left:var(--mc-w)}'
    + 'body.mc-on.mc-rail{padding-left:var(--mc-w-rail)}'
    + 'body.mc-on .nav,body.mc-on #navDrawer{display:none!important}'
    + '}'
    + '@media (max-width:1023.5px){'
    + '.mc-sidebar{transform:translateX(-105%);box-shadow:0 12px 40px rgba(60,30,10,.22);width:min(300px,86vw)}'
    + 'body.mc-nav-open .mc-sidebar{transform:translateX(0)}'
    + 'body.mc-on .nav,body.mc-on #navDrawer{display:none!important}'
    + 'body.mc-on .dc-top{padding-left:64px}'
    + 'body.mc-on .nav{position:static}'
    + '.mc-burger{position:fixed;top:12px;left:12px;z-index:70;width:44px;height:44px;border-radius:12px;'
    + 'border:1px solid var(--line,#EAD9C7);background:var(--card,#fff);color:var(--ink,#1C1408);'
    + 'display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:1.15rem;'
    + 'box-shadow:0 4px 14px rgba(60,30,10,.12)}'
    + 'body.mc-nav-open .mc-burger{left:calc(min(300px,86vw) + 10px)}'
    + '.mc-overlay{position:fixed;inset:0;background:rgba(20,10,0,.42);z-index:65;opacity:0;pointer-events:none;transition:opacity .18s}'
    + 'body.mc-nav-open .mc-overlay{opacity:1;pointer-events:auto}'
    + '}'
    + '@media (min-width:1024px){.mc-burger,.mc-overlay{display:none}}';

  /* ─── DOM ─── */
  function build() {
    var style = document.createElement('style');
    style.id = 'mc-chrome-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    document.body.classList.add('mc-on');

    var path = location.pathname.replace(/\/+$/, '') + '/';
    function active(href) {
      var h = href.replace(/\/+$/, '') + '/';
      return path === h || (h !== '/' && path.indexOf(h) === 0);
    }

    var aside = document.createElement('aside');
    aside.className = 'mc-sidebar';
    aside.setAttribute('aria-label', 'Site navigation');

    var games = GAMES.map(function (g) {
      return '<a class="mc-item' + (active(g.href) ? ' active' : '') + '" href="' + g.href + '">'
        + '<span class="ico">' + g.icon + '</span><span class="lbl">' + gameName(g) + '</span></a>';
    }).join('');

    aside.innerHTML = ''
      + '<button class="mc-collapse" id="mcCollapse" type="button" title="Collapse" aria-label="Collapse sidebar">«</button>'
      + '<a class="mc-brand" href="/"><span class="mk"></span>Memory<b>Duel</b></a>'
      + '<div class="mc-toprow">'
      + '  <a class="mc-play" href="/battle.html">' + t('play') + '</a>'
      + '  <button class="mc-theme" type="button" aria-label="Toggle theme">' + (isDark() ? '☀️' : '🌙') + '</button>'
      + '</div>'
      + '<a class="mc-item' + (active('/') ? ' active' : '') + '" href="/"><span class="ico">🏠</span><span class="lbl">' + t('home') + '</span></a>'
      + '<a class="mc-item' + (active('/games/daily-challenge/') ? ' active' : '') + '" href="/games/daily-challenge/"><span class="ico">📅</span><span class="lbl">' + t('daily') + '</span></a>'
      + '<div class="mc-group">' + t('games') + '</div>'
      + games
      + '<div class="mc-group">' + t('more') + '</div>'
      + '<a class="mc-item' + (active('/train.html') ? ' active' : '') + '" href="/train.html"><span class="ico">🎯</span><span class="lbl">' + t('train') + '</span></a>'
      + '<a class="mc-item' + (active('/membership/') ? ' active' : '') + '" href="/membership/"><span class="ico">🪙</span><span class="lbl">' + t('member') + '</span></a>'
      + '<a class="mc-item" href="/#how"><span class="ico">📖</span><span class="lbl">' + t('how') + '</span></a>'
      + '<div class="mc-foot">'
      + '  <select class="mc-lang" id="mcLang" aria-label="Language">' + langOptions() + '</select>'
      + '  <span class="mc-copy">© 2026</span>'
      + '</div>';

    /* 遮罩 + 移动 burger */
    var overlay = document.createElement('div');
    overlay.className = 'mc-overlay';
    var burger = document.createElement('button');
    burger.className = 'mc-burger';
    burger.type = 'button';
    burger.setAttribute('aria-label', 'Open menu');
    burger.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';

    document.body.appendChild(aside);
    document.body.appendChild(overlay);
    document.body.appendChild(burger);

    /* ─── 事件 ─── */
    aside.querySelector('.mc-theme').addEventListener('click', toggleTheme);
    document.getElementById('mcCollapse').addEventListener('click', function () {
      var rail = document.body.classList.toggle('mc-rail');
      this.textContent = rail ? '»' : '«';
    });
    burger.addEventListener('click', function () {
      document.body.classList.toggle('mc-nav-open');
    });
    overlay.addEventListener('click', function () { document.body.classList.remove('mc-nav-open'); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') document.body.classList.remove('mc-nav-open');
    });
    var langSel = document.getElementById('mcLang');
    langSel.addEventListener('change', function () {
      var lang = this.value;
      try {
        localStorage.setItem('memoryduel_lang', lang);
        localStorage.setItem('lang', lang);
      } catch (e) {}
      /* 站点 i18n 有 API 就热切换，否则带参刷新 */
      var switched = false;
      try {
        if (window.i18n && typeof window.i18n.setLang === 'function') { window.i18n.setLang(lang); switched = true; }
      } catch (e) {}
      if (!switched) {
        var u = new URL(location.href);
        u.searchParams.set('lang', lang);
        location.assign(u.toString());
      }
    });

    /* i18n 热切换后重绘文案（与 eco-home 同事件） */
    document.addEventListener('i18n:change', function () { retext(); });
  }

  function langOptions() {
    var cur = currentLang();
    return Object.keys(DICT).map(function (code) {
      return '<option value="' + code + '"' + (code === cur ? ' selected' : '') + '>' + DICT[code].lang + '</option>';
    }).join('');
  }

  function retext() {
    var map = { '.mc-play': t('play') };
    Object.keys(map).forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) el.textContent = map[sel];
    });
    var groups = document.querySelectorAll('.mc-group');
    if (groups.length >= 2) {
      groups[0].textContent = t('games');
      groups[1].textContent = t('more');
    }
    var items = document.querySelectorAll('.mc-item .lbl');
    var labels = [t('home'), t('daily')]
      .concat(GAMES.map(gameName))
      .concat([t('train'), t('member'), t('how')]);
    for (var i = 0; i < items.length && i < labels.length; i++) items[i].textContent = labels[i];
    var sel = document.getElementById('mcLang');
    if (sel) sel.innerHTML = langOptions();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
