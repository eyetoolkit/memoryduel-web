/* ═══════════════════════════════════════════════════════════════
   MemoryDuel · 每日挑战客户端契约层（memoryduel P0-5，2026-10-12）
   ────────────────────────────────────────────────────────────────
   🔴 为什么另起一个模块，而不是直接复用 daily-challenge.js？
     两个模块的**后端契约完全不同**，混在一起必然出静默失败：

     · daily-challenge.js  → GET /api/daily/{game}?d=YYYYMMDD
       （numeri 旧接口，一次返回 cards + solutions；memoryduel 后端无此路由）
     · 本模块             → GET /api/md/daily/today
                           GET /api/md/daily/puzzle?game=&round=
                           POST /api/md/daily/submit
                           GET /api/md/daily/streak
                           GET /api/md/daily/rank

     若把新契约塞进旧 fetch()，旧的 `if (status===404) return null`
     会把「路由不存在」当成「今天没题」，页面空白且零报错——
     这正是 2026-10-12 在 daily-challenge.js 里刚修掉的反模式。
     本模块因此**不静默吞任何错误**，一律抛出并带上诊断信息。

   🔴 服务端权威红线：
     · dateKey 由服务端算，客户端只读不写，传了也不采信
     · 答案永不回传客户端（submit 响应里没有 digits/seq/colors）
     · 题目只从 /puzzle 这一个出口下发
   ═══════════════════════════════════════════════════════════════ */

(function() {
'use strict';

const API = '/api/md/daily';

/* ─── 会话凭据（匿名 pid+token，与 /api/md/session 同源）─────────
   🔴 必须复用 identity.js 的 `md_session`（{pid, token} JSON），
     不能另起 md-player-id / md-player-token：
     · identity.js 的 ensureSession() / headers() 只认 md_session；
       另起一套 = 同一个浏览器建出第二个 pid，用户名字存到一个没人用的身份上
     · 排行榜/连胜按 pid 统计，两个 pid = 连胜从 1 开始、榜单分裂
     · 换 key 后旧值必须主动迁移，否则已有会话会白白丢一次连胜
   ──────────────────────────────────────────────────────────────── */
const SESSION_KEY = 'md_session';
const LEGACY_PID_KEY = 'md-player-id';
const LEGACY_TOKEN_KEY = 'md-player-token';

function readLegacy() {
  try {
    const pid = localStorage.getItem(LEGACY_PID_KEY);
    const token = localStorage.getItem(LEGACY_TOKEN_KEY);
    return pid && token ? { pid, token } : null;
  } catch (_) { return null; }
}

function loadCred() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (s && s.pid && s.token) return { pid: s.pid, token: s.token };
  } catch (_) { /* 隐私模式或脏数据：落到 legacy 探测 */ }
  // 迁移：早期 P0 构建写进旧 key 的会话，原地搬进 md_session 后删旧值
  const legacy = readLegacy();
  if (legacy) {
    saveCred(legacy.pid, legacy.token);
    try {
      localStorage.removeItem(LEGACY_PID_KEY);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    } catch (_) { /* 删不掉也不影响：loadCred 后续仍走 md_session */ }
  }
  return legacy;
}

function saveCred(pid, token) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ pid: pid, token: token }));
  } catch (_) { /* 隐私模式 / 配额满：不影响本次会话继续玩 */ }
}

/** 认证头：与 worker src/sites/memoryduel/index.js 的 getPid/getAuth 保持一致 */
function authHeaders(cred) {
  const h = { 'Content-Type': 'application/json' };
  if (cred) {
    h['X-Player-ID'] = cred.pid;
    h['X-Player-Token'] = cred.token;
  }
  return h;
}

async function safeJson(r) {
  try { return await r.json(); } catch (_) { return null; }
}

/* ─── 带超时的 fetch ───
   🔴 2026-10-13 加固：原先 7 个 fetch 全部裸调，**没有任何超时**。
   实测把 /api/ 全部挂起（弱网 / 地铁 / DNS 卡住）时，页面会永久停在
   「正在加载今日题目…」—— 用户既看不到原因，也没有任何办法重试，
   只能刷新，而刷新又会再次挂起。
   超时后抛出的错误走的是既有的 catch 路径，最终会渲染成
   「加载失败」+ 重试入口，与网络直接 reject 的表现一致。
   15 秒：CDN 边缘正常响应 <1s，15s 足够覆盖绝大多数弱网抖动。 */
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

async function parseFail(r, body) {
  const e = (body && body.error) || {};
  const err = new Error(
    `[daily-client] ${API} → HTTP ${r.status} ${e.code || ''} ${e.msg || ''}`.trim()
  );
  err.status = r.status;
  err.code = e.code || '';
  return err;
}

/* ─── 确保有匿名会话 ─── */
let sessionPromise = null;

async function ensureSession() {
  const existing = loadCred();
  if (existing) return existing;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    let r;
    try {
      r = await fetchTimeout('/api/md/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      });
    } catch (e) {
      throw new Error(`[daily-client] 无法创建匿名会话：${e && e.message}`);
    }
    const body = await safeJson(r);
    if (!r.ok || !body || !body.data || !body.data.pid) {
      throw await parseFail(r, body);
    }
    saveCred(body.data.pid, body.data.token);
    return { pid: body.data.pid, token: body.data.token };
  })();

  try {
    return await sessionPromise;
  } finally {
    sessionPromise = null;
  }
}

/* ─── 端点 1：今日关卡元信息 + 完成状态（不含题目）────────────── */
async function fetchToday() {
  let r;
  try {
    r = await fetchTimeout(`${API}/today`, { headers: authHeaders(loadCred()), cache: 'no-store' });
  } catch (e) {
    throw new Error(`[daily-client] ${API}/today 网络失败：${e && e.message}`);
  }
  const body = await safeJson(r);
  if (!r.ok) throw await parseFail(r, body);
  if (!body || !body.ok || !body.data) {
    throw new Error(`[daily-client] ${API}/today 响应格式异常`);
  }
  return body.data;
}

/* ─── 端点 2：取题（题目下发的唯一出口）───────────────────────── */
async function fetchPuzzle(game, round) {
  const qs = new URLSearchParams({ game: String(game), round: String(round) });
  let r;
  try {
    r = await fetchTimeout(`${API}/puzzle?${qs}`, {
      headers: authHeaders(loadCred()),
      cache: 'no-store',
    });
  } catch (e) {
    throw new Error(`[daily-client] ${API}/puzzle 网络失败：${e && e.message}`);
  }
  const body = await safeJson(r);
  if (!r.ok) throw await parseFail(r, body);
  if (!body || !body.ok || !body.data || !body.data.puzzle) {
    throw new Error(`[daily-client] ${API}/puzzle 响应缺少 puzzle`);
  }
  return body.data;
}

/** 当前界面语言（word-recall 取题用；跟随 html[lang]，六语兜底 en） */
function fetchAnswerLang() {
  const l = String((document.documentElement.getAttribute('lang') || '')).toLowerCase();
  return ['en', 'zh', 'ja', 'es', 'fr', 'de'].includes(l) ? l : 'en';
}

/* 🔴 word-recall 取题专用：带 lang 走同一条 /puzzle 出口。
   不能让 daily-game.ts 自己去拼 query —— lang 漏传时后端会静默回落 en，
   中文玩家拿到英文单词却不报错，是最难查的一类静默失败。 */
async function fetchPuzzleInLang(game, round, lang, opts) {
  const l = String(lang || fetchAnswerLang()).toLowerCase();
  const qs = new URLSearchParams({ game: String(game), round: String(round), lang: l });
  /* 🔴 2026-10-29：练习（solo / 难度档）带 practice=1。
     /puzzle 的 round 上界默认是**每日赛程长度** level.rounds（多数游戏是 3），
     而难度 hard 档要跑 5 轮 —— 不带这个参数，第 4/5 轮会被服务端
     挡成 400 bad_round，练习模式在最后两轮直接报错。 */
  if (opts && opts.practice) qs.set('practice', '1');
  let r;
  try {
    r = await fetchTimeout(`${API}/puzzle?${qs}`, {
      headers: authHeaders(loadCred()),
      cache: 'no-store',
    });
  } catch (e) {
    throw new Error(`[daily-client] ${API}/puzzle 网络失败：${e && e.message}`);
  }
  const body = await safeJson(r);
  if (!r.ok) throw await parseFail(r, body);
  if (!body || !body.ok || !body.data || !body.data.puzzle) {
    throw new Error(`[daily-client] ${API}/puzzle 响应缺少 puzzle`);
  }
  return body.data;
}

/* ─── 端点 3：提交作答（服务端用同 seed 复算判分）─────────────────
   🔴 不传 dateKey —— 传了服务端也不采信，传了反而误导后来读代码的人。
   🔴 lang 仅 word-recall 需要：判分端要用**与取题同一个**词库重建基准。
      取题传了 lang 而提交不传（或反过来）时，服务端会拿另一语言的词库
      判分，判出来的「正确答案」与玩家看到的题目完全无关。 */
async function submitAnswer(game, round, answer, lang) {
  await ensureSession();
  const body = JSON.stringify(
    lang ? { game, round, answer, lang: String(lang).toLowerCase() } : { game, round, answer }
  );
  let r;
  try {
    r = await fetchTimeout(`${API}/submit`, {
      method: 'POST',
      headers: authHeaders(loadCred()),
      body,
      cache: 'no-store',
    });
  } catch (e) {
    throw new Error(`[daily-client] ${API}/submit 网络失败：${e && e.message}`);
  }
  const body2 = await safeJson(r);
  if (!r.ok) throw await parseFail(r, body2);
  if (!body2 || !body2.ok || !body2.data) {
    throw new Error(`[daily-client] ${API}/submit 响应格式异常`);
  }
  return body2.data;
}

/* ─── 端点 4：连胜状态 ─── */
async function fetchStreak() {
  await ensureSession();
  let r;
  try {
    r = await fetchTimeout(`${API}/streak`, { headers: authHeaders(loadCred()), cache: 'no-store' });
  } catch (e) {
    throw new Error(`[daily-client] ${API}/streak 网络失败：${e && e.message}`);
  }
  const body = await safeJson(r);
  if (!r.ok) throw await parseFail(r, body);
  return body.data;
}

/* ─── 端点 5：排行榜（当前后端返回空榜 + note，未就绪属正常）───── */
async function fetchRank() {
  let r;
  try {
    r = await fetchTimeout(`${API}/rank`, { headers: authHeaders(loadCred()), cache: 'no-store' });
  } catch (e) {
    throw new Error(`[daily-client] ${API}/rank 网络失败：${e && e.message}`);
  }
  const body = await safeJson(r);
  if (!r.ok) throw await parseFail(r, body);
  return body.data;
}

/* ─── 关卡定义（与后端 LEVELS/maxScoreOf/roundLen 对齐，改动需两边同步）──
   🔴 maxScore = **整关**满分（各轮累加），单轮满分另有 roundMax()。
     两者混用会让「本轮满分」永不显示（单轮 3 分 ≠ 关卡 12 分）。
   🔴 2026-10-13 P2 扩至 6 关，三款新增：
     emoji-ghost（Kim's Game 找缺失，四选一）/ chimp-test（数字位置）/
     word-recall（六语 Seen/New 识别记忆）。
   🔴 step = 每轮长度步进。老三关为 1；emoji-ghost 为 2（4/6/8，
     集合记忆负荷随网格增长）；word-recall 为 4（6/10/14）。
     🔴 这三个 step 必须与 worker routes/daily.js 的 roundLen() 完全一致，
     否则满分算错、进度条关数对不上。 */
const LEVELS = {
  'number-recall':   { rounds: 3, startLen: 3, maxLen: 9, maxScore: 12, step: 1, icon: '🔢' },
  'sequence-memory': { rounds: 3, startLen: 3, maxLen: 9, maxScore: 12, step: 1, icon: '⚡' },
  'color-recall':    { rounds: 1, startLen: 5, maxLen: 5, maxScore: 50, step: 0, icon: '🎨' },
  'emoji-ghost':     { rounds: 3, startLen: 4, maxLen: 8, maxScore: 30, step: 2, icon: '👻' },
  'chimp-test':      { rounds: 3, startLen: 5, maxLen: 7, maxScore: 18, step: 1, icon: '🐒' },
  'word-recall':     { rounds: 3, startLen: 6, maxLen: 14, maxScore: 30, step: 4, icon: '📝' },
};
/* 每日挑战轮换池：5 款（word-recall **不进每日**——它的题目按语言分裂，
   进了每日挑战会破坏「全球同一套题」的承诺）。顺序 = 固定展示顺序。 */
const ROTATION_POOL = ['number-recall', 'sequence-memory', 'color-recall', 'emoji-ghost', 'chimp-test'];
/* 兜底队列：后端还没下发 queue 时用（仅首帧）。🔴 只作兜底，
   正常路径一律以 today.queue 为准，否则同一天不同玩家看到不同关卡。 */
const GAME_ORDER = ['number-recall', 'sequence-memory', 'color-recall'];

/** 第 n 轮（1 起）的题目长度：startLen + step*(n-1)，封顶 maxLen */
function roundLen(game, round) {
  const meta = LEVELS[game];
  if (!meta) return 0;
  return Math.min(meta.startLen + (meta.step || 0) * (round - 1), meta.maxLen);
}

/** 第 n 轮（1 起）的满分。
   🔴 三类计分范式：
     · 逐位命中型（number/sequence/chimp）：满分 = 本轮长度
     · 四选一型（emoji-ghost）：每轮固定 10 分
     · 连续还原型（color-recall）：5 色 × 10 = 50（单轮即整关） */
function roundMax(game, round) {
  const meta = LEVELS[game];
  if (!meta) return 0;
  if (game === 'emoji-ghost') return 10;
  if (game === 'color-recall') return meta.startLen * 10;
  if (game === 'word-recall') return roundLen(game, round);
  return roundLen(game, round);
}

/** 把 ?mode=xxx 映射成游戏 + 起始关卡；无效 mode 回大厅（技能要求）。
    🔴 daily 模式不在这里定队列——每日轮换是服务端 seeded 的，
      客户端必须用 today.queue；queue 缺失时才回落 GAME_ORDER。 */
function resolveMode(raw) {
  const mode = String(raw || '').toLowerCase();
  if (mode === 'daily' || mode === '') {
    return { game: 'number-recall', round: 1, queue: GAME_ORDER.slice(), daily: true };
  }
  if (mode === 'number')   return { game: 'number-recall',   round: 1, queue: ['number-recall'] };
  if (mode === 'sequence') return { game: 'sequence-memory', round: 1, queue: ['sequence-memory'] };
  if (mode === 'color')    return { game: 'color-recall',    round: 1, queue: ['color-recall'] };
  if (mode === 'emoji')    return { game: 'emoji-ghost',     round: 1, queue: ['emoji-ghost'] };
  if (mode === 'chimp')    return { game: 'chimp-test',      round: 1, queue: ['chimp-test'] };
  if (mode === 'word')     return { game: 'word-recall',     round: 1, queue: ['word-recall'] };
  return null;
}

const LOBBY_URL = '/games/daily-challenge/lobby/';

const api = {
  API,
  LEVELS,
  GAME_ORDER,
  ROTATION_POOL,
  LOBBY_URL,
  roundLen,
  roundMax,
  ensureSession,
  fetchToday,
  fetchPuzzle,
  fetchPuzzleInLang,
  fetchAnswerLang,   // 🔴 取题必须带语言：word-recall 题目按语言分裂
  submitAnswer,
  fetchStreak,
  fetchRank,
  resolveMode,
  loadCred,
};

if (typeof window !== 'undefined') window.DailyClient = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;

})();
