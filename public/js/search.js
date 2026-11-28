/**
 * 站内搜索（2026-11-28）
 * ────────────────────────────────────────────────────────────
 * 纯客户端检索，数据来自 /search/index.json（由 scripts/quiz/gen-search-index.mjs 生成）。
 *
 * 为什么不用后端：
 *   输入时逐字符查询 D1 会打爆库，而且题目文本本来就整页嵌在 HTML 里，
 *   离线索引比往返查询又快又准。
 *
 * 检索语义：
 *   多词之间是 AND（每个词都得在某个字段里命中），所以 "capital france"
 *   只会留给同时谈论首都和法国的页面，不会被 "france" 单独带偏。
 *
 * 埋点：
 *   查询稳定 1.6s 后上报一次 GA4 view_search_results（GA4 后台「搜索字词」卡片
 *   会自动出现），同时 sendBeacon 到 /api/md/track 落 D1 events 表，
 *   方便以后用 SQL 按真实搜索词挖落地页选题。
 */
(function () {
  'use strict';

  var MAX_HITS = 15;
  var LOG_DELAY = 1600;
  var LOG_MIN_LEN = 3;

  var DOCS = [];
  var input, list, count, popular;
  var tokens = [];
  var results = [];
  var active = -1;
  var timer = null;
  var logTimer = null;
  var logged = {};

  /* ---------- 文本处理 ---------- */

  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  /** 按词高亮：只在词首命中时加 mark，且标点留在 mark 外面（"France?" → <mark>France</mark>?） */
  function mark(text, toks) {
    var parts = String(text).split(/(\s+)/);
    for (var i = 0; i < parts.length; i++) {
      var w = parts[i];
      if (!w || /^\s+$/.test(w)) continue;

      var lead = (w.match(/^[^A-Za-z0-9]*/) || [''])[0];
      var trail = (w.match(/[^A-Za-z0-9]*$/) || [''])[0];
      var core = w.slice(lead.length, w.length - trail.length);
      if (!core) continue;

      var bare = norm(core);
      if (!bare) continue;

      for (var j = 0; j < toks.length; j++) {
        if (toks[j] && bare.indexOf(toks[j]) === 0) {
          parts[i] = lead + '\u0001' + core + '\u0002' + trail;
          break;
        }
      }
    }
    return esc(parts.join(''))
      .replace(/\u0001/g, '<mark>')
      .replace(/\u0002/g, '</mark>');
  }

  /* ---------- 索引预处理 ---------- */

  function prep(d) {
    var fields = [
      { n: norm(d.t), w: 10, p: 0, r: d.t },
      { n: norm(String(d.s).replace(/-/g, ' ')), w: 8, p: 0, r: String(d.s).replace(/-/g, ' ') },
      { n: norm(d.k), w: 4, p: 0, r: d.k },
      { n: norm(d.d), w: 2.5, p: 1, r: d.d },
    ];
    (d.q || []).forEach(function (q) {
      fields.push({ n: norm(q), w: 4.5, p: 3, r: q });
    });
    // 正确答案：解决「记得答案、不记得主题」的搜法（搜 saffron 找食物页）。
    // 权重略低于题干——题干是意图，答案是关键词。
    (d.a || []).forEach(function (a) {
      if (a) fields.push({ n: norm(a), w: 3.8, p: 2, r: 'Answer \u2014 ' + a });
    });
    (d.v || []).forEach(function (v) {
      fields.push({ n: norm(v), w: 3.5, p: 2, r: v });
    });
    (d.f || []).forEach(function (f) {
      fields.push({ n: norm(f), w: 3, p: 2, r: f });
    });
    d._f = fields;
    return d;
  }

  /* ---------- 打分 ---------- */

  function hitScore(tok, hay, w) {
    if (!hay) return 0;
    if (hay === tok) return w * 3;
    if (hay.indexOf(tok) === 0) return w * 2.2;
    if (hay.indexOf(' ' + tok) >= 0) return w * 1.5;
    if (hay.indexOf(tok) >= 0) return w * 0.8;
    return 0;
  }

  function search(query) {
    tokens = norm(query).split(' ').filter(Boolean).slice(0, 6);
    if (!tokens.length) return [];

    var out = [];
    for (var i = 0; i < DOCS.length; i++) {
      var d = DOCS[i];
      var total = 0;
      var snip = null;
      var ok = true;

      for (var t = 0; t < tokens.length && ok; t++) {
        var tok = tokens[t];
        var tokBest = 0;
        var cand = null;
        for (var f = 0; f < d._f.length; f++) {
          var field = d._f[f];
          var sc = hitScore(tok, field.n, field.w);
          if (sc > tokBest) tokBest = sc;
          if (sc > 0 && field.p > 0 && (!cand || field.p > cand.p || (field.p === cand.p && sc > cand.s))) {
            cand = { p: field.p, s: sc, r: field.r };
          }
        }
        if (!tokBest) {
          ok = false;
          break;
        }
        total += tokBest;
        if (cand && (!snip || cand.p > snip.p)) snip = cand;
      }

      if (!ok) continue;
      if (d.p) total += 1.5;
      out.push({ d: d, s: total, snip: snip ? snip.r : '' });
    }

    out.sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s;
      return a.d.t < b.d.t ? -1 : 1;
    });
    return out;
  }

  /* ---------- 渲染 ---------- */

  function chips() {
    var out = '';
    DOCS.forEach(function (d) {
      if (d.p) out += '<a href="' + esc(d.u) + '">' + esc(d.t.replace(/\s*Quiz$/, '')) + '</a>';
    });
    return out || '<a href="/quiz/">Browse all quizzes</a>';
  }

  function clearNone() {
    var el = document.getElementById('sq-none');
    if (el) el.remove();
  }

  function render(query) {
    results = query ? search(query) : [];
    active = -1;
    clearNone();

    if (!query) {
      list.innerHTML = '';
      count.textContent = '';
      if (popular) popular.hidden = false;
      return;
    }
    if (popular) popular.hidden = true;

    var n = results.length;
    if (!n) {
      count.textContent = 'No quiz matches \u201c' + query + '\u201d';
      list.innerHTML = '';
      list.insertAdjacentHTML(
        'afterend',
        '<div class="sq-none" id="sq-none"><p>Nothing in the 166 quizzes matches <strong>' +
          esc(query) +
          '</strong> yet. Try a broader word \u2014 <em>space</em> instead of <em>nebula</em>, <em>war</em> instead of <em>Potsdam</em>.</p><div class="sq-chips">' +
          chips() +
          '</div></div>'
      );
      return;
    }

    count.textContent =
      n === 1
        ? '1 quiz matches \u201c' + query + '\u201d'
        : n + ' quizzes match \u201c' + query + '\u201d' + (n > MAX_HITS ? ' \u2014 showing the top ' + MAX_HITS : '');

    var html = '';
    var shown = Math.min(n, MAX_HITS);
    for (var i = 0; i < shown; i++) {
      var r = results[i];
      html +=
        '<li class="sq-item"><a class="sq-link" href="' +
        esc(r.d.u) +
        '"><span class="sq-title">' +
        esc(r.d.t) +
        '<span class="sq-cat">' +
        esc(r.d.k) +
        '</span></span>' +
        (r.snip ? '<p class="sq-snip">' + mark(r.snip, tokens) + '</p>' : '') +
        '</a></li>';
    }
    list.innerHTML = html;
  }

  /* ---------- 埋点 ---------- */

  function logQuery(q, n, top) {
    if (!q || q.length < LOG_MIN_LEN || logged[q]) return;
    logged[q] = 1;
    try {
      if (window.gtag) window.gtag('event', 'view_search_results', { search_term: q, results: n });
    } catch (e) {
      /* 统计失败不能影响搜索 */
    }
    try {
      var payload = JSON.stringify({
        events: [
          {
            event: 'search',
            sessionId: null,
            timestamp: new Date().toISOString(),
            props: { q: q, n: n, top: top || '' },
          },
        ],
      });
      var url = (window.API_BASE || '') + '/api/md/track';
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      } else {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
          credentials: 'same-origin',
        }).catch(function () {});
      }
    } catch (e) {
      /* 同上 */
    }
  }

  function scheduleLog(q) {
    if (logTimer) clearTimeout(logTimer);
    logTimer = setTimeout(function () {
      logQuery(q, results.length, results.length ? results[0].d.u : '');
    }, LOG_DELAY);
  }

  /* ---------- 交互 ---------- */

  function setActive(i) {
    var items = list.querySelectorAll('.sq-item');
    if (!items.length) return;
    active = (i + items.length) % items.length;
    for (var k = 0; k < items.length; k++) items[k].classList.toggle('is-active', k === active);
    var link = items[active].querySelector('.sq-link');
    if (link) {
      try {
        link.focus({ preventScroll: true });
      } catch (e) {
        link.focus();
      }
    }
  }

  function syncUrl(q) {
    if (window.history && history.replaceState) {
      history.replaceState(null, '', q ? '/search/?q=' + encodeURIComponent(q) : '/search/');
    }
  }

  function run(pushUrl) {
    var q = input.value.trim();
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      render(q);
      if (pushUrl) syncUrl(q);
      if (q) scheduleLog(q);
    }, 90);
  }

  function boot() {
    input = document.getElementById('sq-q');
    list = document.getElementById('sq-list');
    count = document.getElementById('sq-count');
    popular = document.getElementById('sq-popular');
    if (!input || !list) return;

    var params = new URLSearchParams(location.search);
    var initial = (params.get('q') || '').trim();
    if (initial) {
      input.value = initial;
      count.textContent = 'Searching\u2026';
    }

    input.addEventListener('input', function () {
      run(true);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(active + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(active - 1);
      } else if (e.key === 'Escape') {
        input.value = '';
        run(true);
      }
    });

    var form = input.form;
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (timer) clearTimeout(timer);
        var q = input.value.trim();
        render(q);
        syncUrl(q);
        if (q) logQuery(q, results.length, results.length ? results[0].d.u : '');
      });
    }

    fetch('/search/index.json')
      .then(function (r) {
        if (!r.ok) throw new Error('index ' + r.status);
        return r.json();
      })
      .then(function (data) {
        DOCS = (data.docs || []).map(prep);
        if (initial) {
          render(initial);
          scheduleLog(initial);
        }
      })
      .catch(function () {
        count.textContent = 'Search index failed to load \u2014 you can still browse all quizzes.';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
