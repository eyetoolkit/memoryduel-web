/* ============================================================
   Tri-Sites Sidebar Injector
   根据 data-site 自动生成侧栏 HTML + 绑定交互
   三站共用一份脚本
   ============================================================ */
(function(){
  'use strict';

  // ---------- 站点配置（三站在此定义） ----------
  var SITE_CONFIG = {
    board: {
      name: 'Board Duel',
      nameZh: '棋盘对决',
      emoji: '⚔️',
      host: 'boardduel.com',
      games: [
        { icon: '✕◯',  name: 'Tic-Tac-Toe',  zh: '井字棋',   href: '/games/tictactoe/', navKey: 'nav.ttt' },
        { icon: '⚫',  name: 'Gomoku',       zh: '五子棋',   href: '/games/gomoku/',    navKey: 'nav.gomoku' },
        { icon: '🔴',  name: 'Connect 4',    zh: '四子棋',   href: '/games/connect4/',  navKey: 'nav.connect4' },
        { icon: '◐',   name: 'Othello',      zh: '黑白棋',   href: '/games/othello/',   navKey: 'nav.othello' },
        { icon: '♞',   name: 'Chess',        zh: '国际象棋', href: '/games/chess/',     navKey: 'nav.chess' },
        { icon: '⛀',   name: 'Checkers',     zh: '西洋跳棋', href: '/games/checkers/',  navKey: 'nav.checkers' }
      ]
    },
    math: {
      name: 'Math Duel',
      nameZh: '数学对决',
      emoji: '🔢',
      host: 'mathduel.games',
      games: [
        { icon: '24',  name: '24 Game',          zh: '24 点',     href: '/games/24-game/' },
        { icon: '24⁺', name: '24 Easy',         zh: '24 点初级', href: '/games/24-game-easy/' },
        { icon: '9²', name: 'Sudoku',          zh: '数独',     href: '/games/sudoku/' },
        { icon: '6²', name: '6×6 Sudoku',      zh: '6格数独',  href: '/games/sudoku-6x6/' },
        { icon: '☠️',  name: 'Killer Sudoku',   zh: '杀手数独', href: '/games/killer-sudoku/' },
        { icon: '🔺',  name: 'Pyramid',         zh: '金字塔',   href: '/games/equation-pyramid/' }
      ]
    },
    memory: {
      name: 'Memory Duel',
      nameZh: '知识对战',
      emoji: '🧠',
      host: 'memoryduel.com',
      games: [
        { icon: '⚔️',  name: 'Battle Lobby', zh: '对战大厅',   href: '#lobby' },
        { icon: '📝',  name: 'Solo Train',   zh: '单人训练',   href: '/train.html' }
      ]
    }
  };

  // ---------- 品牌矩阵 ----------
  var BRAND_MATRIX = [
    { key: 'board',  emoji: '⚔️', name: 'Board Duel',  zh: '棋盘对决',  desc: '实时棋类对战' },
    { key: 'math',   emoji: '🔢', name: 'Math Duel',   zh: '数学对决',  desc: '数学益智游戏' },
    { key: 'memory', emoji: '🧠', name: 'Memory Duel', zh: '记忆对决',  desc: '知识答题对战' }
  ];

  // ---------- 状态 ----------
  var currentSite = document.documentElement.dataset.site || 'board';
  var cfg = SITE_CONFIG[currentSite] || SITE_CONFIG.board;

  // ---------- 生成侧栏 HTML ----------
  function buildSidebarHTML(){
    var currentPath = location.pathname;
    var activeGame = null;
    for (var i=0; i<cfg.games.length; i++){
      if (currentPath.indexOf(cfg.games[i].href) === 0 || currentPath === cfg.games[i].href.replace(/\/$/, '')) {
        activeGame = cfg.games[i].href;
        break;
      }
    }

    var gamesHTML = cfg.games.map(function(g){
      var active = (g.href === activeGame) ? ' active' : '';
      // i18n.t(k, variables, fallback) — 注意第3参数才是 fallback
      var label = g.name;
      if (g.navKey && window.t) {
        try { label = window.t(g.navKey, null, g.name); } catch(e) { label = g.name; }
      }
      return '<a class="sb-link'+active+'" href="'+g.href+'">'+label+'</a>';
    }).join('\n');

    // 品牌矩阵切换器 HTML
    var switcherHTML = BRAND_MATRIX.map(function(s){
      var isCurrent = (s.key === currentSite);
      var cls = isCurrent ? ' current' : '';
      var target = (isCurrent) ? '#' : ('https://' + SITE_CONFIG[s.key].host + '/');
      return '<button class="sb-site-item'+cls+'" onclick="location.href=\''+target+'\'">' +
        '<span class="sb-site-icon">'+s.emoji+'</span>' +
        '<div class="sb-site-meta">' +
          '<span class="sb-site-name">'+s.emoji+' '+s.name+'</span>' +
          '<span class="sb-site-desc">'+s.desc+'</span>' +
        '</div>' +
      '</button>';
    }).join('\n');

    return '' +
      '<!-- Tri-Sites Sidebar v1 -->' +
      '<aside class="sb" id="triSidebar">' +
        '<!-- 品牌 + 矩阵切换 -->' +
        '<div class="sb-brand">' +
          '<button class="sb-brand-btn" id="sbBrandBtn" type="button" aria-haspopup="true" aria-expanded="false">' +
            '<span class="sb-logo">'+cfg.emoji+'</span>' +
            '<span class="sb-name">'+cfg.nameZh+' <span>Duel</span></span>' +
            '<svg class="sb-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
          '<div class="sb-brand-switcher" id="sbSwitcher" role="menu">' + switcherHTML + '</div>' +
        '</div>' +

        '<!-- 主体 -->' +
        '<nav class="sb-body" aria-label="Main navigation">' +
          '<!-- 首页 -->' +
          '<div class="sb-group">' +
            '<a class="sb-link'+(currentPath==='/' ? ' active' : '')+'" href="/"><span class="sb-icon">🏠</span>首页</a>' +
          '</div>' +

          '<!-- 游戏列表 -->' +
          '<div class="sb-group">' +
            '<div class="sb-group-title">🎮 Games</div>' +
            gamesHTML +
          '</div>' +

          '<div class="sb-group">' +
            '<a class="sb-link" href="/about/"><span class="sb-icon">ℹ️</span>About</a>' +
          '</div>' +
        '</nav>' +

        '<!-- 底部 -->' +
        '<div class="sb-footer">' +
          '<div class="sb-lang-inline" id="sbLangInline"></div>' +
        '</div>' +
      '</aside>' +

      '<!-- 移动端汉堡 -->' +
      '<button class="sb-toggle" id="sbToggle" type="button" aria-label="菜单" aria-expanded="false">☰</button>';
  }

  // ---------- 注入 DOM ----------
  function injectSidebar(){
    // 如果已存在，先移除（重渲染）
    var old = document.getElementById('triSidebar');
    if (old) old.remove();
    var oldToggle = document.getElementById('sbToggle');
    if (oldToggle) oldToggle.remove();

    document.body.insertAdjacentHTML('afterbegin', buildSidebarHTML());

    // 把原来的 <main> 或 .wrap 包进 .sb-main
    wrapMainContent();

    // 绑定交互
    bindSidebarEvents();
  }

  function wrapMainContent(){
    var main = document.querySelector('main');
    var wrap = document.querySelector('.wrap');
    var content = main || wrap || document.body.children[document.body.children.length - 1];
    if (!content) return;

    // 如果已经有 sb-main，跳过
    if (content.parentElement && content.parentElement.classList.contains('sb-main')) return;

    // 创建 sb-main wrapper
    var wrapper = document.createElement('div');
    wrapper.className = 'sb-main';
    content.parentElement.insertBefore(wrapper, content);
    wrapper.appendChild(content);
  }

  // ---------- 交互绑定 ----------
  function bindSidebarEvents(){
    // 品牌矩阵切换器
    var brandBtn = document.getElementById('sbBrandBtn');
    var switcher = document.getElementById('sbSwitcher');
    if (brandBtn && switcher) {
      brandBtn.addEventListener('click', function(e){
        e.stopPropagation();
        var isOpen = switcher.classList.toggle('show');
        brandBtn.classList.toggle('open', isOpen);
        brandBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });
    }

    // 点击外部关闭切换器
    document.addEventListener('click', function(e){
      if (switcher && switcher.classList.contains('show')) {
        if (!switcher.contains(e.target) && e.target !== brandBtn && !brandBtn.contains(e.target)) {
          switcher.classList.remove('show');
          brandBtn.classList.remove('open');
          brandBtn.setAttribute('aria-expanded', 'false');
        }
      }
    });

    // 移动端汉堡
    var toggle = document.getElementById('sbToggle');
    var sb = document.getElementById('triSidebar');
    if (toggle && sb) {
      toggle.addEventListener('click', function(){
        var isOpen = sb.classList.toggle('open');
        toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        document.body.classList.toggle('sb-open', isOpen);
      });
      // 点击链接后移动端自动关闭
      sb.querySelectorAll('a').forEach(function(a){
        a.addEventListener('click', function(){
          if (window.innerWidth <= 760) {
            sb.classList.remove('open');
            toggle.setAttribute('aria-expanded', 'false');
            document.body.classList.remove('sb-open');
          }
        });
      });
    }

    // 语言下拉内联（复用 i18n.js 的 toggleLangMenu / closeLangMenu）
    // 如果页面已有 langDropdown，把它移到侧栏底部
    var existingDD = document.getElementById('langDropdown');
    var langInline = document.getElementById('sbLangInline');
    if (existingDD && langInline) {
      // 隐藏原来的 lang dropdown（在 nav 里）
      existingDD.style.display = 'none';
      // 创建侧栏内的简化语言按钮
      var curEl = document.getElementById('langCurrent');
      var curLabel = curEl ? curEl.textContent : '中';
      langInline.innerHTML = '<button class="sb-link" id="sbLangBtn"><span class="sb-icon">🌐</span>Language ('+curLabel+')</button>';
      langInline.addEventListener('click', function(){
        // 触发 i18n.js 的 toggleLangMenu，但在侧栏上下文
        var dd = document.getElementById('langDropdown');
        if (dd) {
          dd.style.display = '';
          // 临时显示以便点击
          if (typeof window.toggleLangMenu === 'function') {
            window.toggleLangMenu();
          }
        }
      });
    }
  }

  // ---------- DOM Ready ----------
  function ready(fn){
    if (document.readyState !== 'loading') { fn(); }
    else { document.addEventListener('DOMContentLoaded', fn); }
  }

  ready(function(){
    injectSidebar();

    // i18n.js 加载完成后重渲染（让游戏名用翻译）
    if (window.i18nReady) {
      window.i18nReady(function(){ injectSidebar(); });
    } else {
      // 轮询等待 i18n.js
      var tries = 0;
      var timer = setInterval(function(){
        tries++;
        if (window.i18nReady || tries > 50) {
          clearInterval(timer);
          if (window.i18nReady) {
            window.i18nReady(function(){ injectSidebar(); });
          }
        }
      }, 100);
    }
  });

  // 暴露 API
  window.SiteSidebar = {
    inject: injectSidebar,
    config: cfg,
    site: currentSite
  };
})();
