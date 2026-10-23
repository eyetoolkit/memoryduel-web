/**
 * MemoryDuel · 知识对决（Knowledge Battle）大厅页逻辑
 * ────────────────────────────────────────────────────────────────
 * 页面模型（两层，与其余六款大厅页同构）：
 *   /games/knowledge-duel/lobby/   ← 本文件：只做「选分类 + 选模式 + 跳转」
 *        │  模式卡 href / API 调用是唯一真相
 *        ▼
 *   /train.html                    ← 真正的知识对决引擎（AI + 在线房间）
 *
 * 🔴 与其余六款大厅的关键差异（也是本页存在的理由）：
 *   那六款走 duel-lobby.ts（异步房码对战，服务端**没有**匹配队列与 AI），
 *   知识对决走的是**另一套**：train.html 内联引擎自带 AI 对手，
 *   且 /api/md/match/join 是真实存在的匹配端点。
 *   因此本页四个模式**全部真实可用**，不需要任何灰态占位：
 *     vs AI   → /train.html?mode=ai&cat=X
 *     在线匹配 → POST /api/md/match/join → poll → /train.html?room=CODE
 *     创建房间 → POST /api/md/room/create      → /train.html?room=CODE
 *     加入房间 → 校验 6 位码                    → /train.html?room=CODE
 *
 * 🔴 诚信铁律（本页最重要的约束）：
 *   知识对决（train.html）**答对即 +1 分，没有速度加成**。
 *   六款异步对战（duel-sequence.ts）才有「按耗时给速度奖励」的口径。
 *   两者计分规则不同 —— 侧栏只讲本游戏真实的规则，
 *   绝不复用 dl.rule_speed（"Faster answers earn a speed bonus"），
 *   否则等于向玩家承诺一个不存在的奖励。
 *
 * 本页不跑任何游戏逻辑，也不自行建房开局：建房/匹配只拿 code，
 * 真正的入局与错误态由 train.html 自己的引擎负责。
 */

/* 🔴 刻意**不**用 declare global 扩展 Window：
   battle.ts 已经全局声明过 window.MemoryDuelQuiz（其 CATEGORIES 形状是 {id,label}），
   本文件若再 augment 一次，两个声明会合并成互不兼容的类型并报错
   （TS2669：非模块文件里不能 declare global；TS2339：合并后 loading/icon/en 不存在）。
   改为**局部断言**访问：既避开与 battle.ts 的全局冲突，又保留类型安全。 */
interface QuizCat { id: string; icon?: string; en?: string; [k: string]: unknown }
interface QuizApi {
  CATEGORIES?: readonly QuizCat[];
  byCategory?: (cat: string) => unknown[];
  categoryCount?: (cat: string) => number;
  loading?: () => boolean;
  ready?: boolean;
  ensureLoaded?: () => Promise<unknown>;
}
const W = window as unknown as {
  API_BASE?: string;
  i18n?: { getLang?: () => string };
  MemoryDuelQuiz?: QuizApi;
  Identity?: { current?: () => string };
};

const POLL_MAX_MS = 90000; // 匹配最长等待，与 home.mjs POLL_MAX_MS 同值
const ROOM_CODE_RE = /^[A-Z2-9]{6}$/; // 服务端房间码格式（A-Z + 2-9，剔 I/O/0/1）

/* ─── 小工具 ─── */

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] as string));
}

/** 当前语言：URL ?lang > i18n > en（与 train.html 的 getLang 同优先级） */
function curLang(): string {
  try {
    const u = new URLSearchParams(location.search).get('lang');
    if (u) {
      const ul = String(u).split('-')[0].toLowerCase();
      if (['en', 'zh', 'ja', 'es', 'fr', 'de'].indexOf(ul) >= 0) return ul;
    }
  } catch (_) { /* ignore */ }
  try {
    const l = W.i18n && W.i18n.getLang ? W.i18n.getLang() : '';
    if (l) return String(l).split('-')[0].toLowerCase();
  } catch (_) { /* ignore */ }
  return 'en';
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setStatus(msg: string, show: boolean): void {
  const s = el<HTMLParagraphElement>('kbStatus');
  if (!s) return;
  s.hidden = !show;
  s.textContent = msg;
}

/* ─── 会话：pid/token 由服务端签发，客户端不自造（F-010） ─── */

interface Sess { pid: string; token: string }
let sessionPromise: Promise<Sess> | null = null;

function getSession(): Promise<Sess> {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async (): Promise<Sess> => {
    let s: Sess | null = null;
    try { s = JSON.parse(localStorage.getItem('md_session') || 'null') as Sess | null; } catch (_) { s = null; }
    if (s && s.pid && s.token) return s;
    const r = await fetch((W.API_BASE || '') + '/api/md/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    const j = (await r.json()) as { ok?: boolean; data?: { pid?: string; token?: string } };
    if (!j || !j.ok || !j.data || !j.data.pid) throw new Error('session failed');
    s = { pid: j.data.pid, token: j.data.token as string };
    try { localStorage.setItem('md_session', JSON.stringify(s)); } catch (_) { /* 隐私模式 */ }
    return s;
  })();
  return sessionPromise;
}

function authHeaders(s: Sess): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Player-ID': s.pid, 'X-Player-Token': s.token };
}

/** 玩家名：取账号名，绝不回落成 'Player'（全站同名会让服务端按名字复用座位） */
function mdName(): string {
  const I = W.Identity;
  let n = (I && I.current && I.current()) || '';
  if (!n) { try { n = localStorage.getItem('mm_name') || ''; } catch (_) { n = ''; } }
  if (n) return n;
  n = 'Player-' + Math.random().toString(36).slice(2, 6);
  try { localStorage.setItem('mm_name', n); } catch (_) { /* ignore */ }
  return n;
}

/* ─── 分类网格 ───
   与首页 renderCategories 同源的 DOM 契约：
   <button class="cat cat-card" data-cat> + .ci/.cn/.cq 皮肤类 + on/selected 选中态
   两套 class 同时给：.cat/.ci/.cn/.cq 是设计稿皮肤，.cat-card/.selected 是 JS 契约。 */

let selectedCat = '';

/** 题量显示：千分位。
    🔴 不能用 byCategory().length —— bundle 的 count 上限是 100，
    那得到的是「本次拉了多少题」，不是「题库有多少题」，恒显示 100。
    真实总数来自服务端 bundle.total（quiz-data.js 收进 COUNTS）。 */
function fmtCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function renderCategories(): void {
  const grid = el<HTMLDivElement>('catGrid');
  const Q = W.MemoryDuelQuiz;
  if (!grid || !Q || !Q.CATEGORIES) return;

  const cats = Q.CATEGORIES;
  const lang = curLang();
  // 加载期不渲染题量（避免闪一个假数字），但卡片照常可点 —— 题库是按需加载的，
  // 点「vs AI」走 /train.html?cat=xx，那边自行取题，大厅不必等全量题库到位。
  const loading = !!(Q.loading && Q.loading());

  grid.innerHTML = cats.map((c) => {
    const local = (Q.byCategory ? Q.byCategory(c.id) || [] : []).length;
    // 真实总数优先；服务端未下发 total（旧 worker）时退回本地切片长度
    const total = Q.categoryCount ? Q.categoryCount(c.id) : 0;
    const count = total || local;
    const raw = c[lang];
    const name = typeof raw === 'string' && raw ? raw : (c.en || c.id);
    const noQ = !loading && count === 0;
    const countText = loading ? '' : (count > 0 ? fmtCount(count) : 'No questions yet');
    return `<button class="cat cat-card${noQ ? ' locked' : ''}" data-cat="${esc(c.id)}"${
      noQ ? ' disabled' : ''} role="radio" aria-checked="false">
        <span class="ci cat-icon">${esc(c.icon || '🧩')}</span>
        <span class="cn cat-name">${esc(name)}</span>
        <span class="cq cat-count">${esc(countText)}</span>
      </button>`;
  }).join('');

  // 保持已选（若该分类仍可用），否则落到第一个可用分类
  let target = grid.querySelector<HTMLElement>(`.cat[data-cat="${selectedCat}"]:not([disabled])`);
  if (!target) target = grid.querySelector<HTMLElement>('.cat:not([disabled])');
  if (target) selectCat(target);
}

function selectCat(card: HTMLElement): void {
  const grid = el<HTMLDivElement>('catGrid');
  if (!grid) return;
  grid.querySelectorAll<HTMLElement>('.cat').forEach((x) => {
    x.classList.remove('on', 'selected');
    x.setAttribute('aria-checked', 'false');
  });
  card.classList.add('on', 'selected');
  card.setAttribute('aria-checked', 'true');
  selectedCat = card.dataset.cat || '';

  // vs AI 卡：href 随选中分类回填（无 JS 时也能落到默认分类开打）
  const ai = el<HTMLAnchorElement>('kbAiBtn');
  if (ai && selectedCat) {
    ai.setAttribute('href', `/train.html?mode=ai&cat=${encodeURIComponent(selectedCat)}&lang=${curLang()}`);
  }
  const note = el<HTMLElement>('kbSelNote');
  const nm = card.querySelector('.cn');
  if (note && nm) note.textContent = `${nm.textContent || selectedCat} · 10 questions · 15s each`;
}

/* ─── 在线匹配（真实端点：join → poll） ─── */

let matchCancelled = false;

function startMatch(): void {
  const btn = el<HTMLButtonElement>('kbMatchBtn');
  if (!btn || btn.dataset.busy) return;
  btn.dataset.busy = '1';
  matchCancelled = false;
  setStatus('⏳ Matching…', true);

  getSession().then((s) =>
    fetch((W.API_BASE || '') + '/api/md/match/join', {
      method: 'POST', headers: authHeaders(s),
      body: JSON.stringify({ category: selectedCat || 'general', name: mdName() }),
    })
      .then((r) => r.json() as Promise<{ ok?: boolean; data?: { code?: string; matchId?: string } }>)
      .then((j) => {
        if (j.ok && j.data && j.data.code) {
          setStatus('✅ Matched! Joining room…', true);
          location.href = `/train.html?room=${encodeURIComponent(j.data.code)}&lang=${curLang()}`;
          return;
        }
        if (j.ok && j.data && j.data.matchId) {
          pollMatch(j.data.matchId, s, Date.now(), 0);
          return;
        }
        throw new Error('failed');
      })
      .catch((e: Error) => {
        setStatus('❌ ' + (e.message || 'Match failed'), true);
        delete btn.dataset.busy;
      })
  ).catch((e: Error) => {
    setStatus('❌ ' + (e.message || 'Session failed'), true);
    delete btn.dataset.busy;
  });
}

function pollMatch(matchId: string, s: Sess, startedAt: number, attempt: number): void {
  const btn = el<HTMLButtonElement>('kbMatchBtn');
  if (matchCancelled) return;
  if (Date.now() - startedAt > POLL_MAX_MS) {
    setStatus('⏰ No opponent right now — try vs AI or a private room.', true);
    if (btn) delete btn.dataset.busy;
    return;
  }
  fetch((W.API_BASE || '') + '/api/md/match/poll?matchId=' + encodeURIComponent(matchId), {
    headers: authHeaders(s),
  })
    .then((r) => r.json() as Promise<{ ok?: boolean; data?: { code?: string } }>)
    .then((j) => {
      if (j.ok && j.data && j.data.code) {
        setStatus('✅ Matched!', true);
        location.href = `/train.html?room=${encodeURIComponent(j.data.code)}&lang=${curLang()}`;
        return;
      }
      setStatus('⏳ Waiting for opponent…', true);
      const delay = attempt < 3 ? 2000 : (attempt < 6 ? 3000 : 5000); // 退避 2s→3s→5s
      setTimeout(() => pollMatch(matchId, s, startedAt, attempt + 1), delay);
    })
    .catch(() => {
      setStatus('❌ Connection error', true);
      if (btn) delete btn.dataset.busy;
    });
}

/* ─── 建房 / 加房 ─── */

function createRoom(): void {
  const btn = el<HTMLButtonElement>('kbCreateBtn');
  if (!btn || btn.dataset.busy) return;
  btn.dataset.busy = '1';
  setStatus('⏳ Creating room…', true);

  getSession().then((s) =>
    fetch((W.API_BASE || '') + '/api/md/room/create', {
      method: 'POST', headers: authHeaders(s),
      body: JSON.stringify({ mode: '1v1', rounds: 10, maxPlayers: 2 }),
    })
      .then((r) => r.json() as Promise<{ ok?: boolean; data?: { code?: string } }>)
      .then((j) => {
        if (j.ok && j.data && j.data.code) {
          location.href = `/train.html?room=${encodeURIComponent(j.data.code)}&lang=${curLang()}`;
          return;
        }
        throw new Error('failed');
      })
      .catch((e: Error) => {
        setStatus('❌ Create room failed: ' + (e.message || 'network error') + '. Please retry.', true);
        delete btn.dataset.busy;
      })
  ).catch((e: Error) => {
    setStatus('❌ ' + (e.message || 'Session failed'), true);
    delete btn.dataset.busy;
  });
}

function joinRoom(): void {
  const input = el<HTMLInputElement>('kbRoomInput');
  const err = el<HTMLParagraphElement>('kbRoomErr');
  if (!input) return;
  const code = String(input.value || '').trim().toUpperCase();
  // 只接受服务端房间码格式；伪造码直接报错，不浪费一次网络往返
  if (!ROOM_CODE_RE.test(code)) {
    if (err) err.hidden = false;
    input.focus();
    return;
  }
  if (err) err.hidden = true;
  location.href = `/train.html?room=${encodeURIComponent(code)}&lang=${curLang()}`;
}

/* ─── 侧栏规则：只讲本游戏真实的规则 ─── */

function renderRules(): void {
  const host = el<HTMLDivElement>('kbRules');
  if (!host) return;
  const rows: Array<[string, string]> = [
    ['🎯', '10 questions per duel'],
    ['⏱️', '15 seconds per question'],
    ['✅', 'One point per correct answer'],
    ['🤖', 'vs AI: the bot answers in 2–9s and gets ~62% right'],
    ['🌐', 'Online: the server scores both sides'],
  ];
  host.innerHTML = rows
    .map(([ico, nm]) => `<div class="dc-side-row"><span class="ico">${esc(ico)}</span><span class="nm">${esc(nm)}</span></div>`)
    .join('');
}

/* ─── 装配 ─── */

function main(): void {
  renderRules();

  // 题库异步到位后重渲染（补题量）；quiz-data.js 是 defer，可能晚于本模块
  const Q = W.MemoryDuelQuiz;
  if (Q && Q.CATEGORIES) renderCategories();

  window.addEventListener('memoryduel-quiz-ready', () => renderCategories());
  window.addEventListener('memoryduel-ready', () => renderCategories());

  if (Q && !Q.ready && Q.ensureLoaded) {
    Q.ensureLoaded().then(() => renderCategories()).catch(() => { /* 题量留空即可 */ });
  }

  const grid = el<HTMLDivElement>('catGrid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.cat, .cat-card');
      if (!card || (card as HTMLButtonElement).disabled) return;
      selectCat(card);
    });
  }

  el<HTMLButtonElement>('kbMatchBtn')?.addEventListener('click', startMatch);
  el<HTMLButtonElement>('kbCreateBtn')?.addEventListener('click', createRoom);
  el<HTMLButtonElement>('kbJoinBtn')?.addEventListener('click', joinRoom);

  // 房间码输入：回车即加入 + 输入时清错误
  const input = el<HTMLInputElement>('kbRoomInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') joinRoom();
    });
    input.addEventListener('input', () => {
      const err = el<HTMLParagraphElement>('kbRoomErr');
      if (err) err.hidden = true;
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
