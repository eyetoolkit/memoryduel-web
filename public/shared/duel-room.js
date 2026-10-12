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
        r = await fetch(`${API}/session`, {
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
      r = await fetch(API + path, opt);
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
  const GAMES = {
    'sequence-memory': { icon: '⚡', rounds: 3, grid: 3 },
    'number-recall':   { icon: '🔢', rounds: 3, grid: 0 },
    'color-recall':    { icon: '🎨', rounds: 1, grid: 0 },
  };

  function normalizeCode(raw) { return String(raw || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6); }

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
  };

  if (typeof window !== 'undefined') window.DuelRoom = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();