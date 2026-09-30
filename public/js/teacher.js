/* MemoryDuel Teacher Console — minimal v0
 * 复用现有 Worker 路由 /api/md/room/*（已上线，1v1/multi 模式，最长 8 玩家）
 * 不新增后端代码，纯前端包壳。
 */
(function () {
  'use strict';

  var API = (typeof window !== 'undefined' && window.API_BASE) || '';
  var LANG_KEY = 'memoryduel_lang';   // 与 quiz-data.js / train.html 一致
  var PID_KEY = 'memoryduel_pid';
  var SESSION_KEY = 'memoryduel_session_v1';
  var ROOM_KEY = 'memoryduel_teacher_room';

  /* ─── 12 个类目（与 quiz-data.js CATEGORIES 对齐）─── */
  var CATEGORIES = [
    { id: 'science',   icon: '🔬' },
    { id: 'history',   icon: '🏛️' },
    { id: 'geography', icon: '🌍' },
    { id: 'sports',    icon: '⚽' },
    { id: 'movies',    icon: '🎬' },
    { id: 'tech',      icon: '💻' },
    { id: 'culture',   icon: '🎨' },
    { id: 'general',   icon: '🧠' },
    { id: 'games',     icon: '🎮' },
    { id: 'music',     icon: '🎵' },
    { id: 'nature',    icon: '🌿' },
    { id: 'arts',      icon: '🖼️' },
  ];

  /* ─── 6 语 fallback ─── */
  var i18n = {
    cat_name: {
      science:   { en: 'Science',   zh: '科学',   ja: '科学',       es: 'Ciencia',     fr: 'Sciences',    de: 'Wissenschaft' },
      history:   { en: 'History',   zh: '历史',   ja: '歴史',       es: 'Historia',    fr: 'Histoire',    de: 'Geschichte' },
      geography: { en: 'Geography', zh: '地理',   ja: '地理',       es: 'Geografía',   fr: 'Géographie',  de: 'Geographie' },
      sports:    { en: 'Sports',    zh: '体育',   ja: 'スポーツ',   es: 'Deportes',    fr: 'Sports',      de: 'Sport' },
      movies:    { en: 'Movies & TV', zh: '影视', ja: '映画・TV',   es: 'Películas',   fr: 'Films',       de: 'Filme' },
      tech:      { en: 'Technology', zh: '科技',  ja: 'テクノロジー', es: 'Tecnología', fr: 'Technologie', de: 'Technologie' },
      culture:   { en: 'Culture',   zh: '文化',   ja: '文化',       es: 'Cultura',     fr: 'Culture',     de: 'Kultur' },
      general:   { en: 'General',   zh: '常识',   ja: '一般常識',   es: 'General',     fr: 'Général',     de: 'Allgemein' },
      games:     { en: 'Games',     zh: '游戏',   ja: 'ゲーム',     es: 'Juegos',      fr: 'Jeux',        de: 'Spiele' },
      music:     { en: 'Music',     zh: '音乐',   ja: '音楽',       es: 'Música',      fr: 'Musique',     de: 'Musik' },
      nature:    { en: 'Nature',    zh: '自然',   ja: '自然',       es: 'Naturaleza',  fr: 'Nature',      de: 'Natur' },
      arts:      { en: 'Arts',      zh: '艺术',   ja: 'アート',     es: 'Arte',        fr: 'Arts',        de: 'Kunst' },
    },
    rounds_label: { en: 'rounds', zh: '默认', ja: 'デフォルト', es: 'por defecto', fr: 'par défaut', de: 'Standard' },
    live_playing: {
      en: 'Round <b>{round}</b> / {total} — {count} player(s) in the room',
      zh: '第 <b>{round}</b> / {total} 轮 — 房间内 {count} 名玩家',
      ja: 'ラウンド <b>{round}</b> / {total} — 部屋に {count} 人',
      es: 'Ronda <b>{round}</b> / {total} — {count} jugador(es) en la sala',
      fr: 'Manche <b>{round}</b> / {total} — {count} joueur(s) dans la salle',
      de: 'Runde <b>{round}</b> / {total} — {count} Spieler im Raum',
    },
    live_waiting: {
      en: 'Waiting for students… {count} joined so far',
      zh: '等待学生加入… 当前 {count} 人',
      ja: '学生の参加を待機中… 現在 {count} 人',
      es: 'Esperando estudiantes… {count} unidos',
      fr: 'En attente d\'étudiants… {count} ont rejoint',
      de: 'Warten auf Schüler… {count} beigetreten',
    },
    err_create: { en: 'Could not open room: ', zh: '无法创建房间：', ja: '部屋を作成できません：', es: 'No se pudo abrir la sala: ', fr: 'Impossible d\'ouvrir la salle : ', de: 'Raum konnte nicht geöffnet werden: ' },
    err_join:   { en: 'Failed to load room status: ', zh: '读取房间状态失败：', ja: '部屋状態の取得に失敗：', es: 'Error al leer estado: ', fr: 'Échec lecture état : ', de: 'Statusfehler: ' },
    ended:      { en: 'Session ended.', zh: '本节课已结束。', ja: 'セッション終了。', es: 'Sesión finalizada.', fr: 'Session terminée.', de: 'Sitzung beendet.' },
    copy_ok:    { en: 'Link copied!', zh: '链接已复制！', ja: 'リンクをコピーしました！', es: '¡Enlace copiado!', fr: 'Lien copié !', de: 'Link kopiert!' },
    copied:     { en: 'Copied', zh: '已复制', ja: 'コピー済', es: 'Copiado', fr: 'Copié', de: 'Kopiert' },
  };

  function t(key, vars) {
    var lang = (typeof window !== 'undefined' && window.i18n && window.i18n.getLang) ? window.i18n.getLang() : 'en';
    lang = String(lang || 'en').split('-')[0].toLowerCase();
    if (!i18n[key]) return key;
    var s = (i18n[key][lang] || i18n[key].en || key);
    if (vars) s = s.replace(/\{(\w+)\}/g, function (_, k) { return (vars[k] != null) ? vars[k] : '{' + k + '}'; });
    return s;
  }

  function catLabel(id) {
    var lang = (typeof window !== 'undefined' && window.i18n && window.i18n.getLang) ? window.i18n.getLang() : 'en';
    lang = String(lang || 'en').split('-')[0].toLowerCase();
    var map = i18n.cat_name[id] || {};
    return map[lang] || map.en || id;
  }

  /* ─── session：复用 train.html 的 ensureSession 模式（KV pid）─── */
  function getOrCreatePid() {
    try {
      var pid = localStorage.getItem(PID_KEY);
      if (pid && /^[A-Za-z0-9_-]{6,64}$/.test(pid)) return pid;
    } catch (e) {}
    var bytes = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    var pid = '';
    for (var i = 0; i < 16; i++) pid += alphabet[bytes[i % alphabet.length]];
    try { localStorage.setItem(PID_KEY, pid); } catch (e) {}
    return pid;
  }

  function getTeacherName() {
    // 复用 session 名称，或默认「Teacher」
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && s.name) return s.name;
      }
    } catch (e) {}
    return 'Teacher';
  }

  function mdApi(method, path, body) {
    var url = (API || '') + path;
    var opt = { method: method, credentials: 'include' };
    if (body !== undefined) {
      opt.headers = { 'Content-Type': 'application/json' };
      opt.body = JSON.stringify(body);
    }
    return fetch(url, opt).then(function (r) {
      if (!r.ok) return r.text().then(function (txt) {
        throw new Error('HTTP ' + r.status + (txt ? ': ' + txt.slice(0, 80) : ''));
      });
      return r.json();
    });
  }

  /* ─── DOM 辅助 ─── */
  function $(id) { return document.getElementById(id); }
  function showErr(msg) {
    var box = $('errBox'); if (!box) return;
    box.textContent = msg;
    box.classList.remove('hidden');
  }
  function hideErr() { var b = $('errBox'); if (b) b.classList.add('hidden'); }
  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }

  /* ─── 类目 + 轮数选择 ─── */
  function renderCategories() {
    var row = $('catRow'); if (!row) return;
    row.innerHTML = '';
    var lastCat = null;
    try { lastCat = localStorage.getItem('memoryduel_teacher_cat'); } catch (e) {}
    CATEGORIES.forEach(function (c) {
      var chip = document.createElement('span');
      chip.className = 'chip cat' + ((lastCat || 'general') === c.id ? ' sel' : '');
      chip.dataset.cat = c.id;
      chip.innerHTML = c.icon + ' ' + catLabel(c.id);
      chip.addEventListener('click', function () {
        row.querySelectorAll('.chip.cat').forEach(function (n) { n.classList.remove('sel'); });
        chip.classList.add('sel');
        try { localStorage.setItem('memoryduel_teacher_cat', c.id); } catch (e) {}
      });
      row.appendChild(chip);
    });
  }

  function renderRounds() {
    var row = document.querySelectorAll('.chip.rounds');
    var last = parseInt(localStorage.getItem('memoryduel_teacher_rounds') || '15', 10);
    row.forEach(function (chip) {
      chip.classList.remove('sel');
      if (parseInt(chip.dataset.rounds, 10) === last) chip.classList.add('sel');
      chip.addEventListener('click', function () {
        row.forEach(function (n) { n.classList.remove('sel'); });
        chip.classList.add('sel');
        try { localStorage.setItem('memoryduel_teacher_rounds', String(last)); } catch (e) {}
      });
    });
  }

  function renderLangs() {
    var row = $('langRow'); if (!row) return;
    var langs = [
      { id: 'en', label: 'English' },
      { id: 'zh', label: '中文' },
      { id: 'ja', label: '日本語' },
      { id: 'es', label: 'Español' },
      { id: 'fr', label: 'Français' },
      { id: 'de', label: 'Deutsch' },
    ];
    var cur = (localStorage.getItem(LANG_KEY) || (window.i18n && window.i18n.getLang && window.i18n.getLang()) || 'en').split('-')[0];
    row.innerHTML = '';
    langs.forEach(function (l) {
      var chip = document.createElement('span');
      chip.className = 'chip lang' + (l.id === cur ? ' sel' : '');
      chip.textContent = l.label;
      chip.addEventListener('click', function () {
        row.querySelectorAll('.chip.lang').forEach(function (n) { n.classList.remove('sel'); });
        chip.classList.add('sel');
        try { localStorage.setItem(LANG_KEY, l.id); } catch (e) {}
        if (window.i18n && window.i18n.setLang) window.i18n.setLang(l.id);
        renderCategories();   // 重渲染类目多语
      });
      row.appendChild(chip);
    });
  }

  /* ─── 创建房间 ─── */
  function openRoom() {
    hideErr();
    var cat = (document.querySelector('.chip.cat.sel') || {}).dataset?.cat || 'general';
    var rounds = parseInt((document.querySelector('.chip.rounds.sel') || {}).dataset?.rounds || '15', 10);
    var pid = getOrCreatePid();
    $('openBtn').disabled = true;
    $('openBtn').innerHTML = '<span class="spinner"></span>';
    mdApi('POST', '/api/md/room/create', {
      name: getTeacherName(),
      mode: 'multi',
      category: cat,
      rounds: rounds,
      maxPlayers: 8,
    }).then(function (room) {
      try { localStorage.setItem(ROOM_KEY, JSON.stringify({ code: room.code, ts: Date.now(), cat: cat, rounds: rounds })); } catch (e) {}
      showActive(room);
    }).catch(function (err) {
      $('openBtn').disabled = false;
      $('openBtn').textContent = (window.t ? window.t('md_teacher.open_btn') : 'Open classroom room');
      showErr(t('err_create') + err.message);
    });
  }

  /* ─── 展示活动房间 + 二维码 ─── */
  function showActive(room) {
    hide($('setupCard'));
    show($('activeCard'));
    show($('liveCard'));
    $('codeBox').textContent = room.code;
    var lang = (localStorage.getItem(LANG_KEY) || 'en').split('-')[0];
    var joinUrl = location.origin + '/train.html?room=' + encodeURIComponent(room.code) + '&lang=' + encodeURIComponent(lang);
    $('joinLink').textContent = joinUrl;
    try { renderQR(joinUrl); } catch (e) {}
    pollStatus();
  }

  function renderQR(text) {
    var box = $('qrcode');
    if (!box) return;
    box.innerHTML = '';
    if (window.QRCode && window.QRCode.toCanvas) {
      try {
        var c = document.createElement('canvas');
        c.width = 200; c.height = 200;
        box.appendChild(c);
        window.QRCode.toCanvas(c, text, { width: 200, margin: 1 }, function (err) {
          if (err) box.textContent = text;
        });
        return;
      } catch (e) {}
    }
    // 退路：纯文本（学生手抄房间码也可）
    box.innerHTML = '<pre style="font-size:10px;line-height:1.2;word-break:break-all;max-width:200px">' + text + '</pre>';
  }

  /* ─── 轮询房间状态（5 秒）─── */
  var pollTimer = null;
  function pollStatus() {
    if (pollTimer) clearInterval(pollTimer);
    var room = currentRoom();
    if (!room) return;
    var tick = function () {
      mdApi('GET', '/api/md/room/status?code=' + encodeURIComponent(room.code))
        .then(function (st) { renderLive(st); })
        .catch(function (err) {
          $('liveStatus').className = 'status err';
          $('liveStatus').textContent = t('err_join') + err.message;
        });
    };
    tick();
    pollTimer = setInterval(tick, 5000);
  }
  function currentRoom() {
    try {
      var raw = localStorage.getItem(ROOM_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function renderLive(st) {
    var players = st.players || [];
    var status = st.status || 'waiting';
    var ul = $('playerList');
    ul.innerHTML = '';
    players.forEach(function (p) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="name">' + escapeHtml(p.name || p.pid) + '</span><span class="score">' + (p.score || 0) + ' pts</span>';
      ul.appendChild(li);
    });
    var statusEl = $('liveStatus');
    if (status === 'playing') {
      statusEl.className = 'status ok';
      statusEl.innerHTML = t('live_playing', { round: st.round || 1, total: st.totalRounds || '?', count: players.length });
    } else if (status === 'finished') {
      statusEl.className = 'status info';
      statusEl.textContent = t('ended');
    } else {
      statusEl.className = 'status info';
      statusEl.textContent = t('live_waiting', { count: players.length });
    }
    var startBtn = $('startBtn');
    startBtn.disabled = (status !== 'waiting') || (players.length < 2);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ─── 开始本轮 ─── */
  function startRound() {
    var room = currentRoom(); if (!room) return;
    var lang = (localStorage.getItem(LANG_KEY) || 'en').split('-')[0];
    mdApi('POST', '/api/md/room/start', { code: room.code, category: room.cat, lang: lang, rounds: room.rounds })
      .then(function () { pollStatus(); })
      .catch(function (err) { showErr(err.message); });
  }

  function endSession() {
    var room = currentRoom(); if (!room) return;
    mdApi('POST', '/api/md/room/finish', { code: room.code }).catch(function () {});
    try { localStorage.removeItem(ROOM_KEY); } catch (e) {}
    location.reload();
  }

  function newRoom() {
    try { localStorage.removeItem(ROOM_KEY); } catch (e) {}
    location.reload();
  }

  function copyLink() {
    var t = $('joinLink').textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () {
        var btn = $('copyBtn');
        var orig = btn.textContent;
        btn.textContent = t('copy_ok');
        setTimeout(function () { btn.textContent = orig; }, 1500);
      });
    }
  }

  /* ─── 启动 ─── */
  function boot() {
    renderCategories();
    renderRounds();
    renderLangs();
    $('openBtn').addEventListener('click', openRoom);
    $('startBtn').addEventListener('click', startRound);
    $('endBtn').addEventListener('click', endSession);
    $('newBtn').addEventListener('click', newRoom);
    $('copyBtn').addEventListener('click', copyLink);
    // 如果上次还有房间（24h 内）自动恢复
    var last = currentRoom();
    if (last && (Date.now() - (last.ts || 0)) < 24 * 3600 * 1000) {
      mdApi('GET', '/api/md/room/status?code=' + encodeURIComponent(last.code))
        .then(function (st) {
          if (st) showActive({ code: last.code, mode: st.mode });
        }).catch(function () {
          try { localStorage.removeItem(ROOM_KEY); } catch (e) {}
        });
    }
    // 语言切换时重渲染
    window.addEventListener('i18n:change', function () { renderCategories(); });
    window.addEventListener('language-changed', function () { renderCategories(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();