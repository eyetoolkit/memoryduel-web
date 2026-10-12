/**
 * MemoryDuel · Sequence Memory 双人对战（P1-2 · 2026-10-12）
 * ────────────────────────────────────────────────────────────────
 * 为什么先做 Sequence 而不是另两款：
 *   它是「最天然的对决旗舰」——两人看同一串格子，谁记得准谁赢，
 *   无需翻译、无需语言，规则一眼看懂，且天然异步可比。
 *
 * 🔴 对战模型：异步对战（asynchronous duel）
 *   两人**不必同时在线**。各自在方便的时候打开房间、看同一批题、
 *   凭记忆作答，服务端按 (code, round) 保证同题、按各自耗时算速度加成。
 *   为什么不做实时同步：实时需要 WebSocket + 状态广播 + 断线重连，
 *   成本高出数倍，而「各记各的、事后比分」的记忆对战体验已成立
 *   （等价于 Golf / Wordle 的异步对战形态）。
 *
 * 🔴 服务端权威红线：
 *   · 题目只从 /room/round 拿，客户端不生成
 *   · 分数只认服务端 submit 返回的 gained / score
 *   · 客户端不把 puzzle 写进 localStorage（防刷新偷看）
 *   · 展示用 puzzle 只允许存在于内存变量，且作答后立即丢弃
 *
 * 深链：?c=ABC234 直接进入该房间（分享码）
 */

import type {} from '../shared/duel-room';

type Room = { code: string; game?: string; players?: any[]; status?: string; round?: number; totalRounds?: number };

function C(): any {
  const g = window as any;
  if (!g.DuelRoom) throw new Error('[duel-sequence] DuelRoom 未加载');
  return g.DuelRoom;
}

const $ = (s: string) => document.querySelector(s);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/* i18n：缺 key 时 window.t 会回退成 key 原文，必须识别并改用兜底文案 */
function t(key: string, fallback: string): string {
  const g = window as any;
  const fn = (typeof g.t === 'function' && g.t)
    || (g.i18n && typeof g.i18n.t === 'function' ? g.i18n.t.bind(g.i18n) : null);
  if (fn) {
    try {
      const val = fn(key);
      if (typeof val === 'string' && val && val !== key) return val;
    } catch (_) { /* 字典未就绪：用兜底 */ }
  }
  return fallback;
}

const GAME = 'sequence-memory';
const ROUNDS = 3;
const LIT_MS = 600;
const GAP_MS = 240;

/* 当前房间快照。🔴 保留它不只是为了存 code：
   结果页与轮询都要读 status/round/totalRounds，
   若每次都重新拉接口，会出现「刚开完局又渲染成等待中」的闪回。 */
let room: Room | null = null;
let myPid = '';

/* ═══════════ 错误卡（不静默留白）═══════════ */
function renderError(msg: string, retry?: () => void) {
  const card = $('#card')!;
  card.innerHTML = `
    <h2 class="dc-h2">${esc(t('duel.err_title', 'Something went wrong'))}</h2>
    <p class="dc-help error">${esc(msg)}</p>
    ${retry ? `<button class="dc-btn" id="retryBtn" type="button">${esc(t('duel.retry', 'Try again'))}</button>` : ''}`;
  if (retry) {
    document.getElementById('retryBtn')!.addEventListener('click', () => retry());
  }
}

/* ═══════════ 阶段 1：建房 or 加入 ═══════════ */
function renderEntry() {
  const card = $('#card')!;
  card.innerHTML = `
    <h2 class="dc-h2">${esc(t('duel.seq_title', 'Sequence Memory Duel'))}</h2>
    <p class="dc-help">${esc(t('duel.seq_help', 'Memorise the tile sequence, then tap it back. Your opponent gets the exact same sequence — whoever recalls more wins.'))}</p>

    <button class="dc-btn" id="createBtn" type="button">${esc(t('duel.create', 'Create a duel'))}</button>

    <div class="duel-or"><span>${esc(t('duel.or', 'or'))}</span></div>

    <div class="duel-join">
      <label class="duel-label" for="codeIn">${esc(t('duel.join_label', 'Enter room code'))}</label>
      <input class="dc-input duel-code" id="codeIn" maxlength="6" autocomplete="off"
             spellcheck="false" placeholder="ABC234" aria-label="Room code">
      <div class="duel-err" id="codeErr" role="alert"></div>
      <button class="dc-btn ghost" id="joinBtn" type="button">${esc(t('duel.join', 'Join duel'))}</button>
    </div>`;

  document.getElementById('createBtn')!.addEventListener('click', () => doCreate());
  document.getElementById('joinBtn')!.addEventListener('click', () => doJoin());
  const codeIn = document.getElementById('codeIn') as HTMLInputElement;
  codeIn.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') doJoin();
  });
}

async function doCreate() {
  try {
    const r = await C().createRoom(GAME, { rounds: ROUNDS });
    room = { code: r.code };
    await enterRoom(r.code);
  } catch (e) {
    renderError((e as Error).message, () => doCreate());
  }
}

async function doJoin() {
  const errEl = document.getElementById('codeErr')!;
  const raw = (document.getElementById('codeIn') as HTMLInputElement).value;
  const code = C().normalizeCode(raw);
  if (!C().validCode(code)) {
    errEl.textContent = t('duel.bad_code', 'Room codes are 6 letters or digits.');
    return;
  }
  try {
    await C().joinRoom(code, {});
    room = { code };
    await enterRoom(code);
  } catch (e) {
    const err = e as any;
    // 房码不存在 / 房间已满：给具体原因，不要笼统「出错了」
    const why = err.code === 'ROOM_NOT_FOUND'
      ? t('duel.no_such_room', 'No duel found with that code.')
      : err.code === 'ROOM_FULL'
        ? t('duel.room_full', 'That duel is already full.')
        : err.message;
    errEl.textContent = why;
  }
}

/* ═══════════ 阶段 2：房间内（等人 / 开局）═══════════ */
async function enterRoom(code: string) {
  const cred = await C().ensureSession();
  myPid = cred.pid;

  let st: any;
  try {
    st = await C().roomStatus(code);
  } catch (e) {
    renderError((e as Error).message, () => enterRoom(code));
    return;
  }
  room = { code, ...st };

  // 深链落盘：刷新后仍在房间内
  try { sessionStorage.setItem('duel-code', code); } catch (_) {}

  if (st.status === 'waiting') renderWaiting(code, st);
  else renderPlay(code, st);
}

function renderWaiting(code: string, st: any) {
  const card = $('#card')!;
  const isHost = (st.players || []).some((p: any) => p.pid === myPid && p.host);

  card.innerHTML = `
    <h2 class="dc-h2">${esc(t('duel.waiting_title', 'Waiting for your opponent'))}</h2>
    <p class="dc-help">${esc(t('duel.share_hint', 'Share this code — your opponent gets the same sequence.'))}</p>
    <div class="duel-code-box">
      <span class="duel-code-big" id="codeBig">${esc(code)}</span>
      <button class="dc-btn ghost small" id="copyBtn" type="button">${esc(t('duel.copy', 'Copy'))}</button>
    </div>
    <p class="duel-players" id="playersLine"></p>
    ${isHost ? `<button class="dc-btn" id="startBtn" type="button">${esc(t('duel.start', 'Start duel'))}</button>` : ''}
    <p class="duel-note">${esc(t('duel.polling', 'This page checks for your opponent automatically.'))}</p>`;

  const copyBtn = document.getElementById('copyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code);
        copyBtn.textContent = t('duel.copied', 'Copied!');
      } catch (_) {
        // 剪贴板不可用（http / 无权限）：选中文本让用户手动复制
        const el = document.getElementById('codeBig');
        if (el) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        copyBtn.textContent = t('duel.copy_manual', 'Select and copy');
      }
    });
  }

  const startBtn = document.getElementById('startBtn');
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      try {
        await C().startRoom(code, { game: GAME, rounds: ROUNDS });
        renderPlay(code, { status: 'playing', round: 0, totalRounds: ROUNDS });
      } catch (e) {
        renderError((e as Error).message, () => enterRoom(code));
      }
    });
  }

  pollStatus(code);
}

/* 轮询等对手：房间是异步对战，客人可能几分钟后才进来 */
let pollTimer: number | null = null;
function pollStatus(code: string) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  pollTimer = window.setInterval(async () => {
    try {
      const st = await C().roomStatus(code);
      const line = document.getElementById('playersLine');
      if (line) {
        line.textContent = t('duel.players_in', 'In the duel: ') + (st.players || []).map((p: any) => p.name).join(', ');
      }
      if (st.status === 'playing') {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        renderPlay(code, st);
      }
    } catch (_) { /* 轮询失败静默：下一拍再试，不打断等待 UI */ }
  }, 3000);
}

/* ═══════════ 阶段 3：逐轮记忆对战 ═══════════ */
async function renderPlay(code: string, st: any) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  const total = Number(st.totalRounds || ROUNDS);

  for (let round = 0; round < total; round++) {
    showRoundTag(round + 1, total);
    const played = await playRound(code, round);
    if (!played) return;   // 出错已在 playRound 内渲染
  }

  await showResult(code);
}

function showRoundTag(cur: number, total: number) {
  const tag = document.getElementById('roundTag') as HTMLElement | null;
  if (!tag) return;
  tag.hidden = false;
  tag.textContent = `${cur} / ${total}`;
}

async function playRound(code: string, round: number): Promise<boolean> {
  const card = $('#card')!;

  /* 🔴 取题：必须点「开始记忆」才请求 /room/round。
     服务端在返回题目时才开始计时（速度加成按各自真实耗时算），
     所以不能提前把题取好放在页面上。 */
  card.innerHTML = `
    <h2 class="dc-h2">${esc(t('duel.round', 'Round'))} ${round + 1}</h2>
    <p class="dc-help">${esc(t('duel.seq_ready_hint', 'Tap start, watch the tiles light up, then tap them back in the same order.'))}</p>
    <button class="dc-btn" id="go" type="button">${esc(t('duel.start_round', 'Start round'))}</button>`;

  await new Promise<void>((resolve) => {
    document.getElementById('go')!.addEventListener('click', () => resolve(), { once: true });
  });

  let data: any;
  try {
    data = await C().fetchRound(code, round, GAME);
  } catch (e) {
    renderError((e as Error).message, () => playRound(code, round));
    return false;
  }

  const seq: number[] = (data.puzzle && data.puzzle.seq || []).map((n: number) => Number(n));
  const grid = Number(data.puzzle && data.puzzle.grid) || 3;
  if (!seq.length) {
    renderError('[duel-sequence] 服务端未下发序列', () => playRound(code, round));
    return false;
  }

  /* ── 演示阶段 ── */
  const cells = Array.from({ length: grid * grid },
    (_, i) => `<button class="dc-seq-cell" type="button" data-i="${i}" aria-label="${i + 1}"></button>`).join('');
  card.innerHTML = `
    <h2 class="dc-h2">${esc(t('duel.watch', 'Watch carefully…'))}</h2>
    <div class="dc-seq-grid" id="grid" style="grid-template-columns:repeat(${grid},1fr)">${cells}</div>`;

  const nodes = Array.from(document.querySelectorAll<HTMLElement>('.dc-seq-cell'));
  nodes.forEach((n) => n.setAttribute('disabled', ''));

  for (const idx of seq) {
    nodes[idx]?.classList.add('lit');
    await sleep(LIT_MS);
    nodes[idx]?.classList.remove('lit');
    await sleep(GAP_MS);
  }
  await sleep(400);

  /* ── 作答阶段：🔴 必须解除 disabled，否则点了没反应 ── */
  nodes.forEach((n) => n.removeAttribute('disabled'));
  card.querySelector('.dc-h2')!.textContent = t('duel.your_turn', 'Your turn — tap them back');

  /* 🔴 先在 Promise **外部**声明数组再传入：
     若写成 `const picked = await new Promise(r => { ... picked.push(i) ... })`，
     回调里访问 picked 时它还处在暂时性死区（TDZ），
     点第一下就抛 ReferenceError: Cannot access 'picked' before initialization
     —— 页面停在「轮到你了」且点了没反应，极难从表象定位。 */
  const picked: number[] = [];
  await new Promise<void>((resolve) => {
    const onClick = (e: Event) => {
      const el = (e.target as HTMLElement).closest('.dc-seq-cell') as HTMLElement | null;
      if (!el) return;
      const i = Number(el.dataset.i);
      picked.push(i);
      if (picked.length >= seq.length) {
        document.getElementById('grid')!.removeEventListener('click', onClick);
        resolve();
      }
    };
    document.getElementById('grid')!.addEventListener('click', onClick);
  });

  /* ── 提交：🔴 发的是玩家真实点击，不是正确答案 ── */
  let res: any;
  try {
    res = await C().submitAnswer(code, round, picked, {});
  } catch (e) {
    renderError((e as Error).message, () => playRound(code, round));
    return false;
  }

  card.innerHTML = `
    <h2 class="dc-h2">${esc(res.correct ? t('duel.perfect', 'Perfect!') : t('duel.round_done', 'Round complete'))}</h2>
    <div class="dc-result-score">${esc(res.gained)}</div>
    <div class="dc-result-of">${esc(t('duel.points', 'points this round'))}</div>
    <div class="dc-rank">
      <div class="dc-rank-row"><span class="ico">⚡</span><span class="nm">${esc(t('duel.your_total', 'Your total'))}</span><span class="sc">${esc(res.score)}</span></div>
    </div>
    <button class="dc-btn" id="nextBtn" type="button">${esc(t('duel.next', 'Continue'))}</button>`;

  await new Promise<void>((resolve) => {
    document.getElementById('nextBtn')!.addEventListener('click', () => resolve(), { once: true });
  });
  return true;
}

/* ═══════════ 阶段 4：比分 ═══════════ */
async function showResult(code: string) {
  showRoundTag(ROUNDS, ROUNDS);
  const card = $('#card')!;
  card.innerHTML = `<div class="dc-loading">${esc(t('duel.scoring', 'Scoring…'))}</div>`;

  let st: any;
  try {
    st = await C().roomStatus(code);
    room = { code, ...st };
  } catch (e) {
    // 拉不到最新榜单时，用本地房间快照兜底（至少把自己的分数显示出来），
    // 而不是把整页换成错误卡 —— 玩家刚打完三局却什么也看不到，体验最差。
    st = room && room.code === code ? room : null;
    if (!st) {
      renderError((e as Error).message, () => showResult(code));
      return;
    }
  }

  const players = (st.players || []).slice().sort((a: any, b: any) => (b.score || 0) - (a.score || 0));
  const rows = players.map((p: any, i: number) => `
    <div class="dc-rank-row ${p.pid === myPid ? 'me' : ''}">
      <span class="ico">${i === 0 ? '🏆' : '⚡'}</span>
      <span class="nm">${esc(p.name)}${p.pid === myPid ? ' · ' + esc(t('duel.you', 'you')) : ''}</span>
      <span class="sc">${esc(p.score || 0)}</span>
    </div>`).join('');

  card.innerHTML = `
    <h2 class="dc-h2">${esc(t('duel.result_title', 'Duel complete'))}</h2>
    <div class="dc-rank">${rows}</div>
    <div class="duel-code-box">
      <span class="duel-code-big">${esc(code)}</span>
      <button class="dc-btn ghost small" id="copyBtn2" type="button">${esc(t('duel.copy', 'Copy'))}</button>
    </div>
    <p class="duel-note">${esc(t('duel.async_hint', 'Your opponent can still finish their rounds — scores update as they play.'))}</p>
    <button class="dc-btn" id="againBtn" type="button">${esc(t('duel.again', 'New duel'))}</button>
    <a class="dc-btn ghost" href="/" style="margin-top:10px;display:block;text-align:center;text-decoration:none">${esc(t('duel.back_home', '← MemoryDuel'))}</a>`;

  document.getElementById('againBtn')!.addEventListener('click', () => {
    try { sessionStorage.removeItem('duel-code'); } catch (_) {}
    location.href = '/games/sequence-memory/';
  });

  const cb2 = document.getElementById('copyBtn2');
  if (cb2) {
    cb2.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); cb2.textContent = t('duel.copied', 'Copied!'); }
      catch (_) { cb2.textContent = code; }
    });
  }
}

/* ═══════════ 主流程 ═══════════ */
async function main() {
  const params = new URLSearchParams(location.search);
  const invite = params.get('c') || params.get('room');
  let code = invite ? C().normalizeCode(invite) : '';

  if (!code) {
    try { code = sessionStorage.getItem('duel-code') || ''; } catch (_) {}
  }

  if (code && C().validCode(code)) {
    // 深链进入：先尝试加入（已在房内则 join 幂等返回）
    try {
      await C().joinRoom(code, {});
      await enterRoom(code);
      return;
    } catch (e) {
      const err = e as any;
      if (err.code === 'ROOM_FULL' || err.code === 'UNAUTHORIZED') {
        renderError(err.message, () => { location.href = '/games/sequence-memory/'; });
        return;
      }
      // 房码不存在 → 回到入口，别把用户卡在死路
      renderEntry();
      return;
    }
  }

  renderEntry();
}

main().catch((e) => renderError((e as Error).message, () => location.reload()));