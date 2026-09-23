/* ═══════════════════════════════════════════════════════════════
   MemoryDuel Home — 首页交互逻辑
   - 模式切换 (AI vs Online)
   - 题库分类网格渲染
   - 在线匹配 / 房间加入 / 创建
   - 不破坏多语言功能（依赖 window.MemoryDuelQuiz）
   ═══════════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);

// ---------- 模式切换 ----------
function bindModeToggle() {
  const toggle = $('modeToggle');
  if (!toggle) return;
  const aiBtn = toggle.querySelector('[data-m="ai"]');
  const onlineBtn = toggle.querySelector('[data-m="online"]');
  const aiPanel = $('aiPanel');
  const onlinePanel = $('onlinePanel');
  if (!aiBtn || !onlineBtn || !aiPanel || !onlinePanel) return;

  const switchTo = (mode) => {
    const isAi = mode === 'ai';
    aiBtn.classList.toggle('on', isAi);
    onlineBtn.classList.toggle('on', !isAi);
    // aria-selected 必须跟着走，否则屏幕阅读器读到的是旧状态
    aiBtn.setAttribute('aria-selected', String(isAi));
    onlineBtn.setAttribute('aria-selected', String(!isAi));
    // hidden 属性和 style.display 要一起开合：
    // 元素上带 hidden 时，只清 style.display 是没用的（[hidden] 由 UA 样式表提供）
    aiPanel.style.display = isAi ? '' : 'none';
    aiPanel.hidden = !isAi;
    onlinePanel.style.display = isAi ? 'none' : '';
    onlinePanel.hidden = isAi;
  };
  aiBtn.addEventListener('click', () => switchTo('ai'));
  onlineBtn.addEventListener('click', () => switchTo('online'));
  switchTo('ai');
}

// ---------- 分类网格 ----------
// 右上角「已选」小字：显示真实分类名 + 一局的规格
function updateSelLabel(card, fallbackName) {
  const sel = $('catSel');
  if (!sel) return;
  const name = (card && card.querySelector && card.querySelector('.cn'))
    ? card.querySelector('.cn').textContent
    : (fallbackName || '');
  sel.textContent = name ? name + ' \u00b7 10 questions \u00b7 15s each' : 'Pick one to start';
}

function renderCategories() {
  const grid = $('catGrid');
  if (!grid || !window.MemoryDuelQuiz) return;

  const { CATEGORIES, QUESTIONS, byCategory, loading } = window.MemoryDuelQuiz;
  const lang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : 'en';
  const labels = {
    zh: { loading: '加载中…', empty: '暂无题目', select: '选择' },
    en: { loading: 'Loading…', empty: 'No questions yet', select: 'Select' },
    ja: { loading: '読み込み中…', empty: '問題なし', select: '選択' },
    es: { loading: 'Cargando…', empty: 'Sin preguntas', select: 'Seleccionar' },
    fr: { loading: 'Chargement…', empty: 'Pas de questions', select: 'Choisir' },
    de: { loading: 'Lädt…', empty: 'Keine Fragen', select: 'Auswählen' },
  };
  const t = labels[lang] || labels.en;

  // 防止重复绑定 click listener：每次重建时清理旧的事件
  grid.onclick = null;

  const firstName = (list) => {
    const first = list.find((c) => (byCategory(c.id) || []).length > 0);
    if (!first) return null;
    return first[lang] || first.en || first.id;
  };
  const stillLoading = (loading && loading()) || QUESTIONS.length === 0;

  grid.innerHTML = CATEGORIES.map((c) => {
    const count = (byCategory(c.id) || []).length;
    const name = c[lang] || c.en || c.id;
    // 还在加载中：禁用按钮，显示 loading 文字
    // 加载完成但该分类无题：禁用按钮，显示 empty 文字
    // 加载完成且有题：可点击
    const disabled = stillLoading || count === 0;
    const countText = stillLoading ? t.loading : (count > 0 ? count : t.empty);
    // 两套 class 同时给：.cat/.ci/.cn/.cq 是设计稿皮肤，.cat-card/.selected 是旧 JS 契约
    return `
      <button class="cat cat-card${disabled ? ' locked' : ''}" data-cat="${c.id}" ${disabled ? 'disabled' : ''}>
        <span class="ci cat-icon">${c.icon || '🧩'}</span>
        <span class="cn cat-name">${name}</span>
        <span class="cq cat-count">${countText}</span>
      </button>`;
  }).join('');

  // 默认选中第一个有题的分类，右上角小字同步（搜索引擎与真人看到的都是真数据）
  const firstEnabled = grid.querySelector('.cat:not([disabled])');
  if (firstEnabled) firstEnabled.classList.add('on', 'selected');
  updateSelLabel(firstEnabled ? firstEnabled : null, firstName(CATEGORIES) || '');

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.cat, .cat-card');
    if (!card || card.disabled) return;
    grid.querySelectorAll('.cat').forEach((x) => x.classList.remove('on', 'selected'));
    card.classList.add('on', 'selected');
    updateSelLabel(card, card.querySelector('.cn') ? card.querySelector('.cn').textContent : '');
  });
}

// ---------- AI 开始对战 ----------
function bindAiStart() {
  const btn = $('startAiBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const grid = $('catGrid');
    const sel = grid && grid.querySelector('.cat-card.selected:not([disabled])');
    const cat = sel ? sel.dataset.cat : 'general';
    const lang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : 'en';
    const params = new URLSearchParams({ cat, mode: 'ai', lang });
    window.location.href = '/train.html?' + params.toString();
  });
}

// ---------- 会话(F-010: pid 由服务端签发, 客户端不可自造) ----------
let sessionPromise = null;

function getSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    let s = null;
    try { s = JSON.parse(localStorage.getItem('md_session') || 'null'); } catch (e) {}
    if (s && s.pid && s.token) return s;
    const r = await fetch((window.API_BASE || '') + '/md/session', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const j = await r.json();
    if (!j || !j.ok || !j.data || !j.data.pid) throw new Error('session failed');
    s = { pid: j.data.pid, token: j.data.token };
    try { localStorage.setItem('md_session', JSON.stringify(s)); } catch (e) {}
    return s;
  })();
  return sessionPromise;
}

function authHeaders(s) {
  return { 'Content-Type': 'application/json', 'X-Player-ID': s.pid, 'X-Player-Token': s.token };
}

// ---------- 在线匹配 ----------
let matchCancelled = false; // 取消标记:停止 pollMatch 轮询
let currentMatchId = null;  // 当前匹配 id:用于服务端取消(F-003)
const POLL_MAX_MS = 90000;  // F-004: 最长等待 90s

async function startMatch() {
  const btn = $('startMatchBtn');
  const cancel = $('cancelMatchBtn');
  const status = $('matchStatus');
  if (!btn) return;
  if (btn.dataset.busy) return; // 防重入:匹配进行中忽略重复点击
  btn.dataset.busy = '1';
  matchCancelled = false;
  currentMatchId = null;

  const category = (($('catGrid') && $('catGrid').querySelector('.cat-card.selected') || {}).dataset) ? $('catGrid').querySelector('.cat-card.selected').dataset.cat : 'general';

  btn.style.display = 'none';
  if (cancel) cancel.style.display = '';
  if (status) status.textContent = '⏳ Matching…';

  try {
    const s = await getSession();
    const r = await fetch((window.API_BASE || '') + '/md/match/join', {
      method: 'POST',
      headers: authHeaders(s),
      body: JSON.stringify({ category, name: 'Player' })
    });
    const j = await r.json();
    if (j.ok && j.data && j.data.code) {
      if (status) status.textContent = '✅ Matched! Joining room…';
      window.location.href = '/train.html?room=' + encodeURIComponent(j.data.code) + '&lang=' + ((window.i18n && window.i18n.getLang) ? window.i18n.getLang() : 'en');
    } else if (j.ok && j.data && j.data.status === 'waiting') {
      // 轮询(带退避与超时)
      pollMatch(j.data.matchId, s, Date.now(), 0);
    } else {
      throw new Error(j.error ? (j.error.msg || 'failed') : 'failed');
    }
  } catch (err) {
    if (status) status.textContent = '❌ ' + (err.message || 'Match failed');
    btn.style.display = '';
    if (cancel) cancel.style.display = 'none';
    delete btn.dataset.busy;
  }
}

async function pollMatch(matchId, s, startedAt, attempt) {
  const status = $('matchStatus');
  const btn = $('startMatchBtn');
  const cancel = $('cancelMatchBtn');
  if (matchCancelled) return; // 用户已取消,停止轮询(F-003)
  if (Date.now() - startedAt > POLL_MAX_MS) {
    // F-004: 超时停止,给出明确提示
    if (status) status.textContent = '⏰ No opponent right now — try a private room or AI battle.';
    if (btn) { btn.style.display = ''; delete btn.dataset.busy; }
    if (cancel) cancel.style.display = 'none';
    currentMatchId = null;
    return;
  }
  try {
    const r = await fetch((window.API_BASE || '') + '/md/match/poll?matchId=' + encodeURIComponent(matchId), { headers: authHeaders(s) });
    const j = await r.json();
    if (j.ok && j.data && j.data.code) {
      if (status) status.textContent = '✅ Matched!';
      currentMatchId = null;
      window.location.href = '/train.html?room=' + encodeURIComponent(j.data.code) + '&lang=' + ((window.i18n && window.i18n.getLang) ? window.i18n.getLang() : 'en');
      return;
    }
    if (status) status.textContent = '⏳ Waiting for opponent…';
    // F-004: 退避 2s → 3s → 5s
    const delay = attempt < 3 ? 2000 : (attempt < 6 ? 3000 : 5000);
    setTimeout(() => pollMatch(matchId, s, startedAt, attempt + 1), delay);
  } catch (e) {
    if (status) status.textContent = '❌ Connection error';
    if (btn) { btn.style.display = ''; delete btn.dataset.busy; }
    if (cancel) cancel.style.display = 'none';
    currentMatchId = null;
  }
}

function cancelMatch() {
  const btn = $('startMatchBtn');
  const cancel = $('cancelMatchBtn');
  const status = $('matchStatus');
  matchCancelled = true;
  // F-003: 通知服务端移除队列条目, 杜绝幽灵匹配
  if (currentMatchId) {
    const mid = currentMatchId;
    currentMatchId = null;
    getSession().then((s) =>
      fetch((window.API_BASE || '') + '/md/match/cancel', { method: 'POST', headers: authHeaders(s), body: JSON.stringify({ matchId: mid }) })
    ).catch(() => {});
  }
  if (btn) { btn.style.display = ''; delete btn.dataset.busy; }
  if (cancel) cancel.style.display = 'none';
  if (status) status.textContent = '';
}

function bindOnlineMatch() {
  const start = $('startMatchBtn');
  const cancel = $('cancelMatchBtn');
  if (start) start.addEventListener('click', startMatch);
  if (cancel) cancel.addEventListener('click', cancelMatch);
}

// ---------- 房间 ----------
function bindRoomActions() {
  const join = $('joinBtn');
  const create = $('createRoomBtn');
  const input = $('roomInput');
  const status = $('matchStatus');
  const lang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : 'en';

  const roomErr = $('roomErr');
  if (input) {
    input.addEventListener('input', () => {
      const clean = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (clean !== input.value) input.value = clean;
      if (roomErr) roomErr.style.display = 'none';
    });
  }
  if (join && input) {
    join.addEventListener('click', async () => {
      const code = (input.value || '').trim().toUpperCase();
      // F-005: 严格校验 6 位房间码格式, 过短/非法给出明确提示(不再静默)
      if (!/^[A-Z2-9]{6}$/.test(code)) {
        if (roomErr) roomErr.style.display = 'block';
        if (status) status.textContent = '';
        return;
      }
      if (roomErr) roomErr.style.display = 'none';
      // F-005: 跳转前先经服务端校验房间存在
      try {
        const s = await getSession();
        const r = await fetch((window.API_BASE || '') + '/md/room/status?code=' + encodeURIComponent(code), { headers: authHeaders(s) });
        const j = await r.json();
        if (!j.ok) throw new Error('not_found');
      } catch (e) {
        if (status) status.textContent = '❌ Room not found or expired. Check the code and try again.';
        return;
      }
      window.location.href = '/train.html?room=' + encodeURIComponent(code) + '&lang=' + lang;
    });
  }
  if (create) {
    create.addEventListener('click', async () => {
      // F-006: loading/禁用态 + 失败明确反馈
      if (create.dataset.busy) return;
      create.dataset.busy = '1';
      const origText = create.textContent;
      create.disabled = true;
      create.textContent = '⏳ Creating…';
      try {
        const s = await getSession();
        const r = await fetch((window.API_BASE || '') + '/md/room/create', {
          method: 'POST',
          headers: authHeaders(s),
          body: JSON.stringify({ mode: '1v1', rounds: 10, maxPlayers: 2 })
        });
        const j = await r.json();
        if (j.ok && j.data && j.data.code) {
          window.location.href = '/train.html?room=' + encodeURIComponent(j.data.code) + '&lang=' + lang;
          return;
        }
        throw new Error(j.error ? (j.error.msg || 'failed') : 'failed');
      } catch (e) {
        if (status) status.textContent = '❌ Create room failed: ' + (e.message || 'network error') + '. Please retry.';
        create.disabled = false;
        create.textContent = origText;
        delete create.dataset.busy;
      }
    });
  }
}

// ---------- 题库更新时重渲染 ----------
function bindQuizUpdates() {
  // quiz-data.js 异步加载题目，加载完成后触发 memoryduel-ready
  window.addEventListener('memoryduel-ready', () => {
    renderCategories();
  });

  // quiz-data.js 文件本身加载完成（题目可能仍在加载）
  window.addEventListener('memoryduel-quiz-ready', () => {
    renderCategories();
  });

  // 如果已经加载完成，立即渲染
  if (!window.MemoryDuelQuiz) return;
  if (window.MemoryDuelQuiz.ready) {
    renderCategories();
  } else if (window.MemoryDuelQuiz.ensureLoaded) {
    window.MemoryDuelQuiz.ensureLoaded().then(() => {
      renderCategories();
    }).catch(() => {});
  }
}

// ---------- 入口 ----------
export function initHome() {
  bindModeToggle();
  renderCategories();
  bindAiStart();
  bindOnlineMatch();
  bindRoomActions();
  bindQuizUpdates();

  // 语言切换时刷新分类名称
  if (window.i18n && window.i18n.onChange) {
    try { window.i18n.onChange(() => renderCategories()); } catch (e) {}
  }
}

// 首页加载即初始化（本文件仅由 index.html 以 module 方式加载）
initHome();