/* MemoryDuel Teacher Console — minimal v0
 * 复用现有 Worker 路由 /api/md/room/*（已上线，1v1/multi 模式，最长 8 玩家）
 * 不新增后端代码，纯前端包壳。
 */
(function () {
  'use strict';

  var API = (typeof window !== 'undefined' && window.API_BASE) || '';
  var LANG_KEY = 'memoryduel_lang';   // 与 quiz-data.js / train.html 一致
  var SESSION_KEY = 'memoryduel_session_v1';
  var sessionPromise = null;   // pid/token 由服务端签发并配对，见 ensureSession()
  var ROOM_KEY = 'memoryduel_teacher_room';
  var STATUS_KEY = 'memoryduel_teacher_status';   // 最近一次 /room/status 缓存（CSV 导出用）

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
    err_finish_failed: { en: 'Settlement failed — the class did not receive coins', zh: '结算失败——本节课未发放积分', ja: '精算に失敗しました — クラスにはコインが支払われませんでした', es: 'Liquidación fallida: la clase no recibió monedas', fr: 'Échec du règlement — la classe n’a pas reçu de pièces', de: 'Abrechnung fehlgeschlagen — die Klasse hat keine Münzen erhalten' },
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

  /* ─── session：pid/token 由服务端签发并配对（与 train.html:598 ensureSession 同源）
         2026-10-06 修正两条 P0，此前整个教师控制台从未对当前后端工作过：
         ① 请求不带 X-Player-ID / X-Player-Token。后端 getAuth（memoryduel/index.js:82-90）
            只认请求头（或 ?pid=）+ KV 里配对的 token，**从不读 cookie**，
            于是 /room/* 全部 401 —— 教师点任何一下都是 "Could not open room: HTTP 401"。
            旧实现用 getOrCreatePid() 在客户端自造一个 16 位 pid，那是后端明确禁止的
            身份伪造形态（无对应 token，永远通不过校验）。
         ② 响应不解包 {ok,data} 信封，直接把整个信封当业务数据返回。于是
            renderLive 拿到的 st.players 是 undefined → 玩家列表永远空，
            startBtn 因 players.length < 2 永远禁用，codeBox 渲染成 "undefined"，
            CSV 导出只有表头。 */
  function ensureSession() {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (function () {
      var s = null;
      try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) {}
      if (s && s.pid && s.token) return Promise.resolve(s);
      return fetch((API || '') + '/api/md/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.ok || !j.data || !j.data.pid) throw new Error('session_failed');
        s = { pid: j.data.pid, token: j.data.token };
        try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
        return s;
      });
    })();
    return sessionPromise;
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

  function mdApi(method, path, body, retry) {
    var url = (API || '') + path;
    return ensureSession().then(function (s) {
      var opt = {
        method: method,
        credentials: 'same-origin',
        headers: { 'X-Player-ID': s.pid, 'X-Player-Token': s.token },
      };
      if (body !== undefined) {
        opt.headers['Content-Type'] = 'application/json';
        opt.body = JSON.stringify(body);
      }
      return fetch(url, opt).then(function (r) {
        return r.text().then(function (txt) {
          var j = null;
          try { j = JSON.parse(txt); } catch (e) {}
          if (!r.ok || !j || !j.ok) {
            var code = j && j.error && j.error.code;
            // 会话失效(KV 过期/清库)→ 清缓存重新签发并重试一次
            if (code === 'UNAUTHORIZED' && !retry) {
              try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
              sessionPromise = null;
              return mdApi(method, path, body, true);
            }
            throw new Error((j && j.error && (j.error.msg || code)) || ('HTTP ' + r.status));
          }
          return j.data;   // 解包信封：此前直接返回 {ok,data}，下游全部拿到 undefined
        });
      });
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
        // 2026-10-06：此前写的是 String(last)，即**上一次加载时**的值 ——
        // 教师选的轮数从来没被持久化过，每次刷新都回到默认 15。
        var picked = parseInt(chip.dataset.rounds, 10);
        try { localStorage.setItem('memoryduel_teacher_rounds', String(picked)); } catch (e) {}
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
    // 2026-10-06：此处原本取 getOrCreatePid() 的返回值，而那个函数已删除
    //（客户端自造 pid 通不过后端的 KV token 配对校验）。身份现由 mdApi 内部的
    // ensureSession 提供，服务端把 hostPid 取自已鉴权的请求，故此处无需自己持 pid。
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
    // 缓存最近一次 status，供 CSV 导出使用（含每玩家得分）
    try {
      var room = currentRoom();
      if (room) {
        localStorage.setItem(STATUS_KEY, JSON.stringify({ code: room.code, ts: Date.now(), payload: st }));
      }
    } catch (e) {}
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
    /* /room/finish 是 memoryduel **唯一**的发币入口。此前 fire-and-forget +
       无条件 reload：结算失败（会话失效/网络）时全班金币静默丢失，
       教师还因为页面刷新而看不到任何线索。改为等结果再决定是否清本地记录。 */
    mdApi('POST', '/api/md/room/finish', { code: room.code }).then(function () {
      try { localStorage.removeItem(ROOM_KEY); localStorage.removeItem(STATUS_KEY); } catch (e) {}
      location.reload();
    }).catch(function (err) {
      showErr(t('err_finish_failed') + ': ' + (err && err.message ? err.message : 'unknown'));
    });
  }

  function newRoom() {
    try { localStorage.removeItem(ROOM_KEY); localStorage.removeItem(STATUS_KEY); } catch (e) {}
    location.reload();
  }

  /* ─── CSV 导出（W2.3 教师复访触发器）─── */
  function exportCsv() {
    var cached = null;
    try { var raw = localStorage.getItem(STATUS_KEY); if (raw) cached = JSON.parse(raw); } catch (e) {}
    if (!cached || !cached.payload) { showErr(t('err_no_status')); return; }
    var st = cached.payload;
    var room = currentRoom() || { code: st.code || '', rounds: 0, cat: '' };
    var players = (st.players || []).slice();
    players.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    var rows = [
      ['rank', 'player_code', 'score', 'pid', 'room_code', 'category', 'round', 'total_rounds', 'status', 'exported_at_iso'],
    ];
    var nowIso = new Date().toISOString();
    players.forEach(function (p, i) {
      rows.push([
        String(i + 1),
        p.name || p.pid || '',
        String(p.score || 0),
        p.pid || '',
        room.code || '',
        room.cat || '',
        String(st.round || 0),
        String(st.totalRounds || ''),
        st.status || 'unknown',
        nowIso,
      ]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (x) { return '"' + String(x).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'memoryduel-' + (room.code || 'room') + '-' + Date.now() + '.csv';
    a.click();
    URL.revokeObjectURL(url);
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
    $('exportBtn').addEventListener('click', exportCsv);
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