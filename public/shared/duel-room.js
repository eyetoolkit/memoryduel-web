/* ═══════════════════════════════════════════════════════════════
   MemoryDuel · 记忆对战房间客户端（P1-2 · 2026-10-12）
   ────────────────────────────────────────────────────────────────
   为什么另起一个模块，而不是直接抄 train.html / teacher.js 里的 mdApi：
     · 那两处是**内联**在页面里的私有函数，Vite 页面无法 import；
     · 它们只发 { option } 作答，承载不了序列/数字/色彩（红线 #74）；
     · 本模块是 P1-1 新协议的前端配套：房间带 game、逐轮取题、payload 作答。

   🔴 身份：一律复用全站 md_session（identity.js 同一把钥匙）。
     另起 key = 同一浏览器两个 pid = 对战时「自己跟自己比」。

   🔴 不静默吞错：所有网络 / HTTP / 响应结构错误都抛出并带诊断信息。
     房间类接口最容易出的就是「房码对但人不在房里」，静默返回 null
     会让前端停在空白页且零报错 —— 这是本仓已修过两次的反模式。

   🔴 题目语义：/room/round 下发的 puzzle **就是要记的内容**，
     不是「答案泄露」。玩家请求该轮 = 开始记忆，随后凭记忆作答。
     所以本模块绝不缓存 puzzle 到 localStorage（防止刷新后偷看）。
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const SESSION_KEY = 'md_session';
  const API = '/api/md';

  /* ─── 带超时的 fetch ───
     🔴 2026-10-13 加固：原先裸调 fetch 无任何超时。实测把 /api/ 挂起时，
     对战页会**永久停在等待态**—— 房主看不到"对手还没来"的正常等待与
     "网络卡死了"之间的区别，客人则一直转圈。
     超时抛错后走既有catch，渲染成可读错误 + 重试入口。 */
  const FETCH_TIMEOUT_MS = 15000;

  async function fetchTimeout(url, opts) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT_MS) : null;
    try {
      return await fetch(url, ctl ? Object.assign({}, opts || {}, { signal: ctl.signal }) : opts);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error('请求超时（' + Math.round(FETCH_TIMEOUT_MS / 1000) + 's），请检查网络后重试');
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ─── 会话（复用全站 md_session）───────────────────────────── */
  function loadCred() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      return s && s.pid && s.token ? s : null;
    } catch (_) { return null; }
  }

  let sessionPromise = null;
  function ensureSession() {
    const c = loadCred();
    if (c) return Promise.resolve(c);
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      let r;
      try {
        r = await fetchTimeout(`${API}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          cache: 'no-store',
        });
      } catch (e) {
        throw new Error(`[duel-room] 无法创建匿名会话：${e && e.message}`);
      }
      let body = null;
      try { body = await r.json(); } catch (_) {}
      if (!r.ok || !body || !body.data || !body.data.pid) {
        throw new Error(`[duel-room] /session 失败 HTTP ${r.status} ${body && body.error ? body.error.code : ''}`.trim());
      }
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ pid: body.data.pid, token: body.data.token }));
      } catch (_) { /* 隐私模式：本次会话仍可继续 */ }
      return { pid: body.data.pid, token: body.data.token };
    })();
    return sessionPromise.finally(() => { sessionPromise = null; });
  }

  async function call(method, path, body, isRetry) {
    const cred = await ensureSession();
    const opt = {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Player-ID': cred.pid, 'X-Player-Token': cred.token },
    };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }

    let r;
    try {
      r = await fetchTimeout(API + path, opt);
    } catch (e) {
      throw new Error(`[duel-room] ${path} 网络失败：${e && e.message}`);
    }

    let j = null;
    try { j = await r.json(); } catch (_) {}

    // 会话失效（KV 过期/清库）→ 清缓存重签一次
    if (!r.ok && j && j.error && j.error.code === 'UNAUTHORIZED' && !isRetry) {
      try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
      return call(method, path, body, true);
    }
    if (!r.ok || !j || !j.ok) {
      const e = (j && j.error) || {};
      const err = new Error(`[duel-room] ${path} → HTTP ${r.status} ${e.code || ''} ${e.msg || ''}`.trim());
      err.status = r.status;
      err.code = e.code || '';
      throw err;
    }
    return j.data;
  }

  /* ─── 房间 API ─── */
  function validCode(c) { return /^[A-Z2-9]{6}$/.test(String(c || '').toUpperCase()); }

  /** 建房。game: 'sequence-memory' | 'number-recall' | 'color-recall' | 'quiz' */
  function createRoom(game, opts) {
    const o = opts || {};
    return call('POST', '/room/create', {
      game,
      mode: o.mode || '1v1',
      rounds: o.rounds || 3,
      name: o.name,
    });
  }

  function joinRoom(code, opts) {
    const c = String(code || '').toUpperCase();
    if (!validCode(c)) throw new Error('[duel-room] 房码为 6 位字母/数字');
    return call('POST', '/room/join', { code: c, name: (opts || {}).name });
  }

  function startRoom(code, opts) {
    const o = opts || {};
    return call('POST', '/room/start', {
      code: String(code || '').toUpperCase(),
      game: o.game,
      rounds: o.rounds || 3,
      category: o.category,
      lang: o.lang,
    });
  }

  /** 房间状态。🔴 非成员拿不到 players 名单（后端 P1-5 成员闸） */
  function roomStatus(code) {
    return call('GET', `/room/status?code=${encodeURIComponent(String(code || '').toUpperCase())}`);
  }

  /** 逐轮取题（P1-1：start 不再一次发完，防止偷看后续轮） */
  function fetchRound(code, round, game) {
    const c = String(code || '').toUpperCase();
    const qs = new URLSearchParams({ code: c, round: String(round) });
    if (game) qs.set('game', game);
    return call('GET', `/room/round?${qs}`);
  }

  /** 提交作答。payload 为序列/数字串/HSB 数组；quiz 用 option */
  function submitAnswer(code, round, payload, extra) {
    const body = {
      code: String(code || '').toUpperCase(),
      round: Number(round),
      payload: payload === undefined ? null : payload,
    };
    if (extra && typeof extra.option === 'number') body.option = extra.option;
    if (extra && typeof extra.ms === 'number') body.ms = extra.ms;
    return call('POST', '/answer', body);
  }

  function finishRoom(code) {
    return call('POST', '/room/finish', { code: String(code || '').toUpperCase() });
  }

  /* ─── 游戏元信息（与后端 LEVELS 对齐）────────────────────────── */
  /* 🔴 P2（2026-10-13）补齐 emoji-ghost / chimp-test / word-recall。
     ⚠️ 这张表目前只是**参考信息**，渲染代码走 duel-sequence.ts 的
        inferGame()（按 URL 推断）。加新游戏时两处都要改 ——
        这里漏了不会报错（没人读 icon/rounds），
        inferGame() 漏了则会被当成 sequence-memory 静默玩错游戏。 */
  const GAMES = {
    'sequence-memory': { icon: '⚡', rounds: 3, grid: 3 },
    'number-recall':   { icon: '🔢', rounds: 3, grid: 0 },
    'color-recall':    { icon: '🎨', rounds: 1, grid: 0 },
    'emoji-ghost':     { icon: '👻', rounds: 3, grid: 0 },
    'chimp-test':      { icon: '🐒', rounds: 3, grid: 5 },
    'word-recall':     { icon: '📝', rounds: 3, grid: 0 },
  };

  function normalizeCode(raw) { return String(raw || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6); }
  /* ─── 离线感知层（纯前端，2026-10-20）───────────────────────
     🔴 为什么单独一层而不是改 call()/fetchRound()：
       本模块的对战是**异步模型**（逐轮 /room/round 拉题），
       不存在实时连接要"重连"。真正要兜的是三类断线场景：
       ① 玩家侧物理断网（WiFi 掉了 / 电梯 / 进地库），但页面没刷新，
          后续 fetchRound 会 15s 超时才报错 —— 玩家要干等 15s 才知道。
       ② 弱网：onLine 仍为 true 但请求持续失败（navigator.onLine
          在 iOS/Android 上并不可靠，这是它最大的坑）。
       ③ 页面切后台：mobile 应用挂起 fetch 定时器，回来时房间状态
          可能已变（对手已打完/房间过期），需要主动重拉一次。
       三个场景都是**"网络变了"**而不是"逻辑错了"，所以把感知
       集中在一个模块，duel-sequence.ts 只订阅状态 + 在 fetchRound
       失败时通知一次，不侵入对战主循环。

     🔴 红线：这里**只读、只报状态，绝不调 /room/** —— 重拉题目的
       动作仍归 duel-sequence.ts 自己决定（它才知道当前 code/round）。
       netwatch 是传感器不是执行器，保持职责单一。 */

  var NETWATCH_STATE = {
    online: (typeof navigator !== 'undefined' && navigator.onLine !== false) || true,
    lastFailAt: 0,          // 最近一次被 duel-sequence 上报的 fetch 失败时间戳
    lastSuccessAt: 0,       // 最近一次成功的 fetch（含 session/create/status/round/answer）
    failStreak: 0,          // 连续失败次数；成功即清零
    wasVisible: (typeof document !== 'undefined' && document.visibilityState === 'visible'),
    handlers: []
  };

  function _netSnapshot() {
    // "弱网"判定：onLine 为 true 但最近一次是失败且连续失败 ≥2 次。
    // 只信一次失败可能是偶发抖动（单次超时不代表断网），
    // 连失两次才升级为可见的"网络不佳"横幅，避免无谓惊吓。
    var weak = !NETWATCH_STATE.online || (NETWATCH_STATE.failStreak >= 2 && NETWATCH_STATE.lastFailAt > 0);
    return { online: NETWATCH_STATE.online, weak: weak, failStreak: NETWATCH_STATE.failStreak };
  }

  function _netNotify() {
    var snap = _netSnapshot();
    for (var i = 0; i < NETWATCH_STATE.handlers.length; i++) {
      try { NETWATCH_STATE.handlers[i](snap); } catch (_) { /* 订阅者崩掉不影响其它订阅者 */ }
    }
  }

  var netwatch = {
    /** duel-sequence.ts 在启动对战时调一次；重复调用安全（幂等）。 */
    watch: function () {
      if (typeof window === 'undefined') return;
      var onOnline = function () {
        NETWATCH_STATE.online = true;
        NETWATCH_STATE.failStreak = 0;   // 网络恢复 → 视为"清零"，不再算弱网
        _netNotify();
      };
      var onOffline = function () {
        NETWATCH_STATE.online = false;
        _netNotify();
      };
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
    },
    /** duel-sequence.ts 在 fetchRound / submitAnswer 等 call() 成功 resolve 后调。 */
    noteSuccess: function () {
      NETWATCH_STATE.lastSuccessAt = Date.now();
      NETWATCH_STATE.failStreak = 0;
      _netNotify();
    },
    /** duel-sequence.ts 在 call() 抛网络类错误（非业务 4xx）的 catch 里调。
        🔴 只上报"网络层"失败：HTTP 4xx/5xx 是服务端明确回话，不算断网，
           传 true 表示是网络层（超时/TypeError/AbortError）失败，
           业务错误传 false（或省略）则不计入弱网判定。 */
    noteFailure: function (isNetworkLayer) {
      NETWATCH_STATE.lastFailAt = Date.now();
      if (isNetworkLayer === true) NETWATCH_STATE.failStreak++;
      _netNotify();
    },
    isOffline: function () { return !NETWATCH_STATE.online; },
    snapshot: function () { return _netSnapshot(); },
    /** 订阅状态变化，返回取消订阅函数。duel-sequence.ts 用它驱动横幅。 */
    onChange: function (cb) {
      if (typeof cb !== 'function') return function () {};
      NETWATCH_STATE.handlers.push(cb);
      return function () {
        var idx = NETWATCH_STATE.handlers.indexOf(cb);
        if (idx >= 0) NETWATCH_STATE.handlers.splice(idx, 1);
      };
    }
  };

  /* 🔴 visibilitychange 也归 netwatch：切后台后 fetch 的 15s 超时计时器
       在 mobile 上会被浏览器挂起/不准，恢复前台那一刻"上次失败时间戳"
       可能已经陈旧。duel-sequence.ts 在 visibilitychange 里读
       netwatch.snapshot().lastFailAt 判断"是否要在回来时主动重拉一轮"。 */
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      NETWATCH_STATE.wasVisible = (document.visibilityState === 'visible');
    });
  }


  const api = {
    API,
    GAMES,
    validCode,
    normalizeCode,
    loadCred,
    ensureSession,
    createRoom,
    joinRoom,
    startRoom,
    roomStatus,
    fetchRound,
    submitAnswer,
    finishRoom,
    netwatch,
  };

  if (typeof window !== 'undefined') window.DuelRoom = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();