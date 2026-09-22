/* ═══════════════════════════════════════════════════════════════
   MemoryDuel UI i18n Apply — 替换 HTML 中的硬编码中文文案
   - 不依赖 data-i18n 属性，直接 textContent 匹配 + 替换
   - 与 window.t / window.i18n 协同
   - 监听 langchange 自动重新应用
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // key → data-i18n path
  var UI_MAP = [
    { selector: '.hero .badge',         key: 'home.badge',          type: 'text' },
    { selector: '.hero h1 em',          key: 'home.h1em',           type: 'text' },
    { selector: '.hero p',              key: 'home.desc',           type: 'text' },
    { selector: '#lobby .sec-head h2',  key: 'home.section_title_1',type: 'text' },
    { selector: '#modeToggle .mode-btn[data-m="ai"]',     key: 'home.mode_ai',      type: 'text' },
    { selector: '#modeToggle .mode-btn[data-m="online"]', key: 'home.mode_online',  type: 'text' },
    { selector: '#aiPanel .sec-head h2',     key: 'home.select_cat',   type: 'text' },
    { selector: '#btnStart',                  key: 'home.start_ai',     type: 'text' },
    { selector: '#onlinePanel .sec-head h2',  key: 'home.section_title_2', type: 'text' },
    { selector: '#btnRandom',                 key: 'home.quick_match',  type: 'text' },
    { selector: '#btnCreateRoom',             key: 'home.create_1v1',   type: 'text' },
    { selector: '#btnCreateMulti',            key: 'home.create_multi', type: 'text' },
    { selector: '#btnJoinRoom',               key: 'home.join',         type: 'text' },
    { selector: '#readyPanel h2',             key: 'home.ready',        type: 'text' },
    { selector: '#readyText',                 key: 'home.cat_selected', type: 'text', prefix: true },
    { selector: '#btnGo',                     key: 'home.start_quiz',   type: 'text' },
    { selector: '#endPanel h2',               key: 'result.title',      type: 'text' },
    { selector: '#rCorrect',                  key: 'result.hits',       type: 'text', prefix: true },
    { selector: '#rSpeed',                    key: 'result.avg_speed',  type: 'text', prefix: true },
    { selector: '#btnAgain',                  key: 'result.play_again', type: 'text' },
    { selector: '#btnHome',                   key: 'result.back_lobby', type: 'text' },
    // "玩法" section
    { selector: '#info .sec-head h2',          key: 'home.section_title_3', type: 'text' },
    { selector: '#info .cat:nth-child(1) .name', key: 'train.feat_timer', type: 'text' },
    { selector: '#info .cat:nth-child(2) .name', key: 'home.lang_label',  type: 'text', fallback: '多语言' },
    { selector: '#info .cat:nth-child(3) .name', key: 'train.feat_card',  type: 'text', fallback: 'AI 陪练' },
    { selector: '#info .cat:nth-child(4) .name', key: 'train.feat_diff',  type: 'text', fallback: '段位等级' },
  ];

  var t9 = function (key) {
    if (window.t) return window.t(key, null, key);
    return key;
  };

  function applyOne(item) {
    var el = document.querySelector(item.selector);
    if (!el) return false;
    var txt = t9(item.key);
    if (txt === item.key) return false;
    if (item.prefix) {
      // 保留前缀（如"📡 正在..."），只替换冒号后部分
      var orig = el.textContent || '';
      var colonIdx = orig.indexOf(':');
      var sepIdx = orig.indexOf('：');
      var idx = colonIdx >= 0 ? colonIdx : (sepIdx >= 0 ? sepIdx : -1);
      if (idx >= 0) el.textContent = orig.slice(0, idx + 1) + txt;
      else el.textContent = txt;
    } else {
      el.textContent = txt;
    }
    return true;
  }

  function applyAll() {
    var count = 0;
    for (var i = 0; i < UI_MAP.length; i++) {
      if (applyOne(UI_MAP[i])) count++;
    }
    return count;
  }

  // 等 i18n 加载完（window.i18nReady 或 DOMContentLoaded 后）
  function run() {
    if (window.i18nReady) {
      window.i18nReady(function () { applyAll(); });
    } else if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(applyAll, 50); });
    } else {
      setTimeout(applyAll, 50);
    }
  }

  // 语言切换时重新应用
  window.addEventListener('langchange', function () {
    setTimeout(applyAll, 30);
  });

  run();
})();