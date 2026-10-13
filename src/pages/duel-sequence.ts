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

/* ─── 游戏由 URL 决定（P1-3 Number / P1-5 Color / P2 三款新游戏共用同一套对战内核）──
   🔴 为什么不是一个 URL + 参数，而是多个独立页面：
     每个游戏一条独立 URL 才能各自进 sitemap、各自有 OG/标题，
     SEO 上是多个落地页而不是一个。但**代码只有一份** ——
     由路径推断 game，避免复制粘贴出多份会逐渐分叉的实现。
     只有「题目长什么样 + 玩家怎么作答」两处有差异，其余（建房、
     等待、轮询、提交、比分）完全共用。 */
function inferGame(): string {
  const p = location.pathname;
  if (/\/games\/number-recall\//.test(p)) return 'number-recall';
  if (/\/games\/color-recall\//.test(p)) return 'color-recall';
  if (/\/games\/emoji-ghost\//.test(p)) return 'emoji-ghost';
  if (/\/games\/chimp-test\//.test(p)) return 'chimp-test';
  if (/\/games\/word-recall\//.test(p)) return 'word-recall';
  return 'sequence-memory';
}
const GAME: string = inferGame();
const ROUNDS = 3;
const LIT_MS = 600;
const GAP_MS = 240;
/** 颜色阵列的展示时长。与 daily 的 playColor 保持一致，玩家不必在两种玩法间换预期。 */
const COLOR_SHOW_MS = 4200;
/** 三款新游戏的展示时长。与 daily-game.ts 的同名常量逐字一致，
    免得玩家在同一款游戏的两处体验到不同时长、以为其中一处坏了。 */
const EMOJI_SHOW_MS = 3400;
const CHIMP_LIT_MS = 700;
const CHIMP_GAP_MS = 180;
const WORD_STEP_MS = 760;

/** 每个游戏的专属文案前缀，避免在多款游戏间写 if 分支 */
const ICON = GAME === 'number-recall' ? '🔢'
  : GAME === 'color-recall' ? '🎨'
  : GAME === 'emoji-ghost' ? '👻'
  : GAME === 'chimp-test' ? '🐒'
  : GAME === 'word-recall' ? '📝'
  : '⚡';

/** 站内跳转必须回本页，不能硬编码 sequence-memory */
function gameHome(g: string): string {
  return g === 'sequence-memory' ? '/games/sequence-memory/' : `/games/${g}/`;
}
const GAME_HOME = gameHome(GAME);

/* ─── HSB → CSS（Color Recall 用，P1-5）────────────
   🔴 必须与 daily-game.ts 的 hsbToCss **逐字一致**，不要「顺手优化」。
     玩家在每日挑战里看到的颜色和在对决里看到的颜色若是两个值，
     「同一套东西」的说法当场破产；而且这种分叉极难被肉眼发现 ——
     只在两个页面来回切、盯着同一个色号对比时才看得出来。
     故此处直接照搬，不做 RGB 转换之���的「更好」实现。
     为什么复制而不抽公共 util：两个文件是各自独立的 Vite 入口
     （daily-game / duel-sequence），抽 util 会多出一条跨入口依赖链，
     而这段只有一行。 */
function hsbToCss(h: number, s: number, b: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(b)}%)`;
}

/* 当前房间快照。🔴 保留它不只是为了存 code：
   结果页与轮询都要读 status/round/totalRounds，
   若每次都重新拉接口，会出现「刚开完局又渲染成等待中」的闪回。 */
let room: Room | null = null;
let myPid = '';
/* 🔴 是否房主必须在 **create 响应里**判定并记住：
   /room/status 返回的 players 不带 host 字段（后端有意不对外暴露谁是房主），
   等进房后再靠 p.host 判断会恒为 false —— 房主看不到「开始对决」按钮，
   房间永远停在等待中，整局打不起来。 */
let iAmHost = false;

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

/** 每个游戏一组文案。新增游戏只改这张表，不改渲染代码。 */
const COPY: Record<string, { title: string; help: string; readyHint: string }> = {
  'sequence-memory': {
    title: t('duel.seq_title', 'Sequence Memory Duel'),
    help: t('duel.seq_help', 'Memorise the tile sequence, then tap it back. Your opponent gets the exact same sequence — whoever recalls more wins.'),
    readyHint: t('duel.seq_ready_hint', 'Tap start, watch the tiles light up, then tap them back in the same order.'),
  },
  'number-recall': {
    title: t('duel.num_title', 'Number Recall Duel'),
    help: t('duel.num_help', 'Memorise the digits, then type them back. Your opponent gets the exact same number — whoever recalls more wins.'),
    readyHint: t('duel.num_ready_hint', 'Tap start, watch the digits flash, then type them from memory.'),
  },
  'color-recall': {
    title: t('duel.col_title', 'Colour Recall Duel'),
    help: t('duel.col_help', 'Memorise the colours, then rebuild them on the wheel. Your opponent gets the exact same colours — closest match wins.'),
    readyHint: t('duel.col_ready_hint', 'Tap start, watch the colours appear, then rebuild each one as closely as you can.'),
  },
  /* 🔴 P2（2026-10-13）三款新游戏的对战文案。
     ⚠️ 键前缀用 duel.* 而不是 dc.*：每日挑战与对战是两套文案体系，
        共用 dc.* 会让「每日挑战的措辞」反过来约束对战页。
        六语字典两套都要有，缺一则该页显示英文兜底（不报错，极难发现）。 */
  'emoji-ghost': {
    title: t('duel.emoji_title', 'Emoji Ghost Duel'),
    help: t('duel.emoji_help', 'A row of symbols flashes, then one is missing. Your opponent gets the exact same set — pick the ghost correctly.'),
    readyHint: t('duel.emoji_ready_hint', 'Tap start, watch the symbols appear, then pick the one that was in the set.'),
  },
  'chimp-test': {
    title: t('duel.chimp_title', 'Chimp Test Duel'),
    help: t('duel.chimp_help', 'Numbers flash on the grid, then vanish. Your opponent gets the exact same grid — tap every cell that held a number.'),
    readyHint: t('duel.chimp_ready_hint', 'Tap start, watch the numbers flash, then tap every cell that held one.'),
  },
  'word-recall': {
    title: t('duel.word_title', 'Word Recall Duel'),
    help: t('duel.word_help', 'Words appear one by one. Your opponent gets the exact same words — mark each as seen or new.'),
    readyHint: t('duel.word_ready_hint', 'Tap start, watch the words appear, then mark each as seen or new.'),
  },
};
const cp = COPY[GAME] || COPY['sequence-memory'];

function renderEntry() {
  const card = $('#card')!;
  card.innerHTML = `
    <h2 class="dc-h2">${esc(cp.title)}</h2>
    <p class="dc-help">${esc(cp.help)}</p>

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
    // 先确保有会话，才能把「自己」和 create 响应里的房主 pid 对上
    await C().ensureSession();
    const r = await C().createRoom(GAME, { rounds: ROUNDS });
    room = { code: r.code };
    /* 建房的那一刻自己必然是房主。把 create 响应里 host=true 的 pid 记下来，
       enterRoom 里与自己的 pid 比对即可 —— 不依赖 status 是否回传 host。 */
    const hostPid = (r.players || []).find((p: any) => p.host)?.pid || '';
    const cred = C().loadCred();
    iAmHost = !!(hostPid && cred && hostPid === cred.pid);
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

  // 深链落盘：刷新后仍在房间内。
  // 🔴 房主身份也要一起存：status 不回传 host，刷新后不恢复就再也开不了局。
  try {
    sessionStorage.setItem('duel-code', code);
    if (iAmHost) sessionStorage.setItem('duel-host', '1');
  } catch (_) {}

  if (st.status === 'waiting') renderWaiting(code, st);
  else renderPlay(code, st);
}

function renderWaiting(code: string, st: any) {
  const card = $('#card')!;
  const isHost = iAmHost;

  card.innerHTML = `
    <h2 class="dc-h2">${esc(t('duel.waiting_title', 'Waiting for your opponent'))}</h2>
    <p class="dc-help">${esc(t('duel.share_hint', 'Share this code — your opponent gets the same sequence.'))}</p>
    <div class="duel-code-box">
      <span class="duel-code-big" id="codeBig">${esc(code)}</span>
      <button class="dc-btn ghost small" id="copyBtn" type="button">${esc(t('duel.copy', 'Copy'))}</button>
    </div>
    <p class="duel-players" id="playersLine">${esc(t('duel.players_in', 'In the duel: '))}${esc((st.players || []).map((p: any) => p.name).join(', '))}</p>
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
        const r = await C().startRoom(code, { game: GAME, rounds: ROUNDS });
        /* 🔴 只有服务端确认 started 才渲染作答界面。
           原写法 `await start(); renderPlay()` 把失败都吞进 catch 之外的路径：
           限流 429 / 网络抖动时 start 实际没生效，房间仍是 waiting，
           但页面已经跳到「轮到你了」，玩家点半天提交不上去
           （服务端回 WRONG_TURN: game not playing）。
           必须先看服务端返回值，不盲信「没抛异常就等于成功」。 */
        if (!r || r.started !== true) {
          renderError(t('duel.start_failed', 'Could not start the duel. Please try again.'),
            () => enterRoom(code));
          return;
        }
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
  const isNumber = GAME === 'number-recall';
  const isColor = GAME === 'color-recall';
  const isEmoji = GAME === 'emoji-ghost';
  const isChimp = GAME === 'chimp-test';
  const isWord = GAME === 'word-recall';

  /* 🔴 取题：必须点「开始记忆」才请求 /room/round。
     服务端在返回题目时才开始计时（速度加成按各自真实耗时算），
     所以不能提前把题取好放在页面上。 */
  card.innerHTML = `
    <h2 class="dc-h2">${esc(t('duel.round', 'Round'))} ${round + 1}</h2>
    <p class="dc-help">${esc(cp.readyHint)}</p>
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

  /* ── 按游戏解析题目（三款游戏唯一的差异点之一）── */
  const seq: number[] = (data.puzzle && data.puzzle.seq || []).map((n: number) => Number(n));
  const grid = Number(data.puzzle && data.puzzle.grid) || 3;
  const digits: string = GAME === 'number-recall'
    ? String((data.puzzle && data.puzzle.digits || []).join(''))
    : '';
  /* 🔴 颜色关的契约是 HSB **对象数组** [{h,s,b}]，不是颜色名字符串。
     喂字符串会让下游 hsbToCss 算出 NaN 度色，界面变成一团黑。 */
  const colors: Array<{ h: number; s: number; b: number }> =
    isColor && Array.isArray(data.puzzle && data.puzzle.colors)
      ? data.puzzle.colors.map((c: any) => ({ h: Number(c && c.h) || 0, s: Number(c && c.s) || 0, b: Number(c && c.b) || 0 }))
      : [];

  /* 🔴 P2 三款新游戏的题目字段。publicView 已按游戏脱敏下发，
     这里只做「拿到就解析、拿不到就报明确错」，不自行生成任何内容。 */
  const pz = data.puzzle || {};
  const emojiSet: string[] = (pz.grid || []).map((e: unknown) => String(e));
  const emojiOptions: string[] = (pz.options || []).map((e: unknown) => String(e));
  const chimpGrid: number = Number(pz.grid) || 5;
  const chimpPositions: number[] = (pz.positions || []).map((n: unknown) => Number(n));
  const words: string[] = (pz.words || []).map((w: unknown) => String(w));

  const target = isNumber ? digits : '';
  const noPuzzle = isNumber ? !target.length
    : isColor ? !colors.length
    : isEmoji ? (!emojiSet.length || emojiOptions.length !== 4)
    : isChimp ? !chimpPositions.length
    : isWord ? !words.length
    : !seq.length;
  if (noPuzzle) {
    renderError(`[duel] 服务端未下发 ${GAME} 题目`, () => playRound(code, round));
    return false;
  }

  /* ── 作答：两个游戏的交互不同，但「发玩家真实作答」这一条完全相同 ── */
  let answer: unknown;

  if (isNumber) {
    /* Number Recall：逐位闪现 → 输入整串 */
    card.innerHTML = `
      <h2 class="dc-h2">${esc(t('duel.watch', 'Watch carefully…'))}</h2>
      <div class="dc-num-stage hide" id="stage" aria-live="off"></div>`;
    const stage = $('#stage') as HTMLElement;

    for (let i = 0; i < target.length; i++) {
      stage.textContent = target[i];
      stage.classList.remove('hide', 'show');
      void stage.offsetWidth;   // 强制重排以重启动画
      stage.classList.add('show');
      await sleep(LIT_MS);
    }
    stage.textContent = target;
    void stage.offsetWidth;
    stage.classList.add('show');
    await sleep(1100);
    stage.textContent = '';
    stage.classList.add('hide');
    stage.classList.remove('show');

    card.innerHTML = `
      <h2 class="dc-h2">${esc(t('duel.your_turn_num', 'Your turn — type the digits'))}</h2>
      <input class="dc-input" id="ans" inputmode="numeric" autocomplete="off"
             maxlength="${target.length}" placeholder="${'0'.repeat(target.length)}"
             aria-label="${esc(t('dc.num_aria', 'Digits you remember'))}" />`;

    const ans = $('#ans') as HTMLInputElement;
    ans.focus();
    // 🔴 同样先声明再进 Promise，避免 TDZ（见下方 sequence 分支的说明）
    const typedRef: { v: string } = { v: '' };
    await new Promise<void>((resolve) => {
      ans.addEventListener('input', () => {
        ans.value = ans.value.replace(/\D/g, '').slice(0, target.length);
        if (ans.value.length === target.length) { typedRef.v = ans.value; resolve(); }
      });
      ans.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter' && ans.value.length) { typedRef.v = ans.value; resolve(); }
      });
    });
    answer = typedRef.v;
  } else if (isColor) {
    /* ── Color Recall：颜色闪现 → 逐色在色轮/滑块上还原 ──
       交互与 daily 的 playColor 同构（色轮定色相+明度，滑块定饱和度），
       但**目标色初值不再等于答案**：daily 里滑块默认值就是目标色
       （单人练习，玩家只是走个形式）；对战里默认给中性值，
       否则玩家什么都不动就能满分，比赛直接失去意义。 */
    card.innerHTML = `
      <h2 class="dc-h2">${esc(t('duel.watch', 'Watch carefully…'))}</h2>
      <div class="dc-color-row" id="row"></div>`;

    const row = $('#row')!;
    row.innerHTML = colors
      .map((c) => `<div class="dc-color-swatch" style="background:${hsbToCss(c.h, c.s, c.b)}"></div>`)
      .join('');
    await sleep(COLOR_SHOW_MS);
    row.innerHTML = '';

    const answers: Array<{ h: number; s: number; b: number }> = [];

    for (let i = 0; i < colors.length; i++) {
      const tgt = colors[i];
      const target = hsbToCss(tgt.h, tgt.s, tgt.b);

      card.innerHTML = `
        <h2 class="dc-h2">${esc(t('duel.col_pick', `Colour ${i + 1} of {total} — match it as closely as you can.`)
          .replace('{n}', String(i + 1)).replace('{total}', String(colors.length)))}</h2>
        <div class="dc-color-target" style="width:100%;height:120px;background:${target}" aria-label="${esc(t('dc.col_target', 'Target colour'))}"></div>
        <div class="dc-wheel" id="wheel" role="application" aria-label="${esc(t('dc.col_wheel', 'Colour wheel'))}"
             style="background:conic-gradient(from 0deg,#FF0000,#FFFF00,#00FF00,#00FFFF,#0000FF,#FF00FF,#FF0000)"></div>
        <p class="dc-wheel-hint">${esc(t('dc.col_hint', 'Click or drag on the wheel to set hue and lightness; use the sliders for saturation.'))}</p>
        <div class="dc-sliders">
          <div class="dc-slider-row"><span>H</span><input type="range" id="h" min="0" max="359" value="0" /><output id="ho">0</output></div>
          <div class="dc-slider-row"><span>S</span><input type="range" id="s" min="20" max="100" value="50" /><output id="so">50</output></div>
          <div class="dc-slider-row"><span>B</span><input type="range" id="b" min="10" max="95" value="50" /><output id="bo">50</output></div>
        </div>
        <div class="dc-color-swatch" id="preview" style="width:100%;height:64px;background:${target}"></div>
        <button class="dc-btn" id="lock" type="button" style="margin-top:14px">${esc(t('dc.col_lock', 'Lock this colour'))}</button>`;

      const h = document.getElementById('h') as HTMLInputElement;
      const s = document.getElementById('s') as HTMLInputElement;
      const b = document.getElementById('b') as HTMLInputElement;
      const ho = document.getElementById('ho') as HTMLOutputElement;
      const so = document.getElementById('so') as HTMLOutputElement;
      const bo = document.getElementById('bo') as HTMLOutputElement;
      const preview = $('#preview') as HTMLElement;
      const wheel = $('#wheel') as HTMLElement;

      const sync = () => {
        ho.textContent = h.value; so.textContent = s.value; bo.textContent = b.value;
        preview.style.background = hsbToCss(+h.value, +s.value, +b.value);
      };
      [h, s, b].forEach((el) => el.addEventListener('input', sync));

      const wheelPick = (e: PointerEvent) => {
        const r = wheel.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        const dist = Math.hypot(dx, dy) / (r.width / 2);
        if (dist < 0.08) return;   // 中心是灰盘，忽略
        let deg = Math.atan2(dy, dx) * (180 / Math.PI);
        if (deg < 0) deg += 360;
        h.value = String(Math.round(deg) % 360);
        const nv = Math.round(95 - Math.min(dist, 1) * 85);
        b.value = String(Math.max(10, Math.min(95, nv)));
        sync();
      };
      wheel.addEventListener('pointerdown', (e) => {
        wheel.setPointerCapture((e as PointerEvent).pointerId);
        wheelPick(e as PointerEvent);
      });
      wheel.addEventListener('pointermove', (e) => {
        if (e.buttons === 1) wheelPick(e);
      });

      await new Promise<void>((resolve) => {
        document.getElementById('lock')!.addEventListener('click', () => resolve(), { once: true });
      });

      answers.push({ h: +h.value, s: +s.value, b: +b.value });
    }
    answer = answers;
  } else if (isEmoji) {
    /* ── Emoji Ghost：集合闪现 → 四选一挑出「刚才在里面」的那个 ──
       与每日挑战的 playEmojiGhost 同构。DOM 结构（.dc-emoji-row /
       .dc-emoji / .dc-emoji-options / .dc-emoji-opt）刻意保持一致，
       于是两处共用同一套 duel.css 样式，不需要再写一份。 */
    card.innerHTML = `
      <h2 class="dc-h2">${esc(t('duel.watch', 'Watch carefully…'))}</h2>
      <div class="dc-emoji-row" id="row" aria-live="off"></div>`;

    const row = $('#row')!;
    row.innerHTML = emojiSet.map((e) => `<span class="dc-emoji">${esc(e)}</span>`).join('');
    await sleep(EMOJI_SHOW_MS);
    row.innerHTML = '';

    card.innerHTML = `
      <h2 class="dc-h2">${esc(t('duel.emoji_pick', 'Which one was in the set?'))}</h2>
      <div class="dc-emoji-options" id="opts" role="radiogroup" aria-label="${esc(t('duel.emoji_pick', 'Which one was in the set?'))}">
        ${emojiOptions.map((e, i) => `<button class="dc-emoji-opt" type="button" role="radio" aria-checked="false" data-i="${i}">${esc(e)}</button>`).join('')}
      </div>`;

    const opts = $('#opts')!;
    answer = await new Promise<number>((resolve) => {
      opts.addEventListener('click', (e) => {
        const el = (e.target as HTMLElement).closest('.dc-emoji-opt') as HTMLElement | null;
        if (!el) return;
        opts.querySelectorAll('.dc-emoji-opt').forEach((n) => {
          n.setAttribute('aria-checked', 'false');
          n.classList.remove('picked');
        });
        el.setAttribute('aria-checked', 'true');
        el.classList.add('picked');
        const pick = Number(el.dataset.i);
        setTimeout(() => resolve(pick), 180);
      });
    });
  } else if (isChimp) {
    /* ── Chimp Test：数字逐格闪现 → 消失 → 点出所有数字格 ── */
    const size = chimpGrid * chimpGrid;
    const cell = (i: number) => `<div class="dc-chimp-cell" data-i="${i}"></div>`;

    card.innerHTML = `
      <h2 class="dc-h2">${esc(t('duel.watch', 'Watch carefully…'))}</h2>
      <div class="dc-chimp-grid" id="grid" style="grid-template-columns:repeat(${chimpGrid},1fr)">
        ${Array.from({ length: size }, (_, i) => cell(i)).join('')}
      </div>`;

    const showGrid = $('#grid')!;
    const nodes = Array.from(showGrid.querySelectorAll<HTMLElement>('.dc-chimp-cell'));
    for (let k = 0; k < chimpPositions.length; k++) {
      const pos = chimpPositions[k];
      const n = nodes[pos];
      if (!n) continue;
      n.textContent = String(k + 1);
      n.classList.add('lit');
      await sleep(CHIMP_LIT_MS);
      n.classList.remove('lit');
      await sleep(CHIMP_GAP_MS);
    }
    await sleep(500);
    nodes.forEach((n) => { n.textContent = ''; });

    card.innerHTML = `
      <h2 class="dc-h2">${esc(t('duel.chimp_pick', 'Tap every cell that held a number.'))}</h2>
      <p class="dc-help">${esc(t('duel.chimp_count', 'There were {n} numbers.').replace('{n}', String(chimpPositions.length)))}</p>
      <div class="dc-chimp-grid" id="grid" style="grid-template-columns:repeat(${chimpGrid},1fr)">
        ${Array.from({ length: size }, (_, i) => cell(i)).join('')}
      </div>
      <button class="dc-btn" id="done" type="button" style="margin-top:14px">${esc(t('dc.chimp_done', 'Done'))}</button>`;

    const grid2 = $('#grid')!;
    /* 🔴 数组必须在 Promise **外部**声明：写成
       `const picked = await new Promise(r => { ...picked.push(i) })`
       会让回调里的 picked 处于暂时性死区，点第一格就抛 ReferenceError，
       页面停在「轮到你」且点击无反应。 */
    const picked: number[] = [];
    grid2.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('.dc-chimp-cell') as HTMLElement | null;
      if (!el || picked.length >= chimpPositions.length) return;
      const i = Number(el.dataset.i);
      if (picked.includes(i)) return;
      picked.push(i);
      /* 用 .lit（daily-challenge.css 里已定义）而不是自造 .picked ——
         另起类名就得再补一条样式，漏补时选中态完全不可见，
         玩家会以为点击没生效。.wrong 是每日挑战的即时反馈，
         对战里不给（判分在提交后统一给，避免中途泄露对错）。 */
      el.classList.add('lit');
    });

    await new Promise<void>((resolve) => {
      document.getElementById('done')!.addEventListener('click', () => resolve(), { once: true });
    });
    answer = picked;
  } else if (isWord) {
    /* ── Word Recall：词逐个出现 → 逐词判断见过 / 没见过 ──
       🔴 语言一致性红线（已核过服务端契约，这里**不要**多此一举传 lang）：
         房间题的 lang 在**题目生成时已固化** —— buildRoomPuzzles(game, seed, n, lang)
         把建房端传来的 lang 传进 buildPuzzle，publicView 再把 puzzle.lang 随题目下发，
         服务端 judgeAgainst 直接读 room.bundle[r].words 复算。
         即判分基准与题目来自**同一个已固化的 bundle**，与前端传什么无关。
         若在此处再从 <html lang> 猜一个值上传，反而可能与题目语言不一致，
         把本来正确的判分搞错。故只提交 marks。 */
    card.innerHTML = `
      <h2 class="dc-h2">${esc(t('duel.watch', 'Watch carefully…'))}</h2>
      <div class="dc-word-stage" id="stage" aria-live="off"></div>`;

    const stage = $('#stage')!;
    stage.innerHTML = `<div class="dc-word-now" id="now"></div><div class="dc-word-prog" id="prog"></div>`;
    const now = document.getElementById('now') as HTMLElement;
    const prog = document.getElementById('prog') as HTMLElement;
    for (let i = 0; i < words.length; i++) {
      now.textContent = words[i];
      prog.textContent = `${i + 1} / ${words.length}`;
      await sleep(WORD_STEP_MS);
    }
    now.textContent = '';
    prog.textContent = '';
    await sleep(350);

    card.innerHTML = `
      <h2 class="dc-h2">${esc(t('duel.word_judge', 'Your turn — mark each word'))}</h2>
      <div class="dc-word-list" id="list">
        ${words.map((w, i) => `
          <div class="dc-word-row" data-i="${i}">
            <span class="w">${esc(w)}</span>
            <span class="opts">
              <button class="dc-word-btn" type="button" data-i="${i}" data-v="new">${esc(t('dc.word_new', 'New'))}</button>
              <button class="dc-word-btn" type="button" data-i="${i}" data-v="seen">${esc(t('dc.word_seen', 'Seen'))}</button>
            </span>
          </div>`).join('')}
      </div>
      <button class="dc-btn" id="lock" type="button" style="margin-top:14px">${esc(t('dc.word_lock', 'Submit answers'))}</button>`;

    const marks = new Array(words.length).fill('');
    const list = document.getElementById('list')!;
    list.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.dc-word-btn') as HTMLElement | null;
      if (!btn) return;
      const i = Number(btn.dataset.i);
      marks[i] = btn.dataset.v || '';
      const row = list.querySelector(`.dc-word-row[data-i="${i}"]`);
      if (row) row.classList.toggle('answered', !!marks[i]);
      list.querySelectorAll(`.dc-word-btn[data-i="${i}"]`).forEach((b) => {
        b.classList.toggle('on', (b as HTMLElement).dataset.v === marks[i]);
      });
    });

    await new Promise<void>((resolve) => {
      document.getElementById('lock')!.addEventListener('click', () => resolve(), { once: true });
    });
    // 未判定的词按 'new' 提交：与每日挑战同一兜底，服务端按比例计分而非判零
    answer = marks.map((v) => v || 'new');
  } else {
    /* Sequence Memory：格子依次点亮 → 按序点回 */
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
    answer = picked;
  }

  /* ── 提交：🔴 发的是玩家真实作答，不是正确答案 ── */
  let res: any;
  try {
    res = await C().submitAnswer(code, round, answer, {});
  } catch (e) {
    renderError((e as Error).message, () => playRound(code, round));
    return false;
  }

  card.innerHTML = `
    <h2 class="dc-h2">${esc(res.correct ? t('duel.perfect', 'Perfect!') : t('duel.round_done', 'Round complete'))}</h2>
    <div class="dc-result-score">${esc(res.gained)}</div>
    <div class="dc-result-of">${esc(t('duel.points', 'points this round'))}</div>
    <div class="dc-rank">
      <div class="dc-rank-row"><span class="ico">${ICON}</span><span class="nm">${esc(t('duel.your_total', 'Your total'))}</span><span class="sc">${esc(res.score)}</span></div>
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
    try {
      sessionStorage.removeItem('duel-code');
      sessionStorage.removeItem('duel-host');
    } catch (_) {}
    location.href = GAME_HOME;
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
    try {
      code = sessionStorage.getItem('duel-code') || '';
      if (sessionStorage.getItem('duel-host') === '1') iAmHost = true;
    } catch (_) {}
  }

  if (code && C().validCode(code)) {
    // 深链进入：先尝试加入（已在房内则 join 幂等返回）
    try {
      await C().joinRoom(code, {});
      /* 🔴 加入后必须**回读一次状态确认自己真在房里**。
         只看「join 没抛异常」不够：限流/重试路径下它可能静默没生效，
         于是页面显示等待页、玩家干等，而服务端根本不认这个 pid
         （后续取题直接 FORBIDDEN: not_in_room）。 */
      const cred = await C().ensureSession();
      const st = await C().roomStatus(code);
      const inRoom = (st.players || []).some((p: any) => p.pid === cred.pid);
      if (!inRoom) {
        renderError(t('duel.join_failed', 'Could not join that duel. Check the code and try again.'),
          () => { location.href = GAME_HOME; });
        return;
      }
      await enterRoom(code);
      return;
    } catch (e) {
      const err = e as any;
      /* 🔴 限流 429 必须显式告诉用户「稍后再试」：
         原逻辑把它兜进 renderEntry()，用户以为房码错了反复重试，
         反而继续撞限流 —— 错误提示要能指导下一步动作。 */
      if (err.status === 429) {
        renderError(t('duel.rate_limited', 'Too many requests. Wait a moment and try again.'),
          () => { location.reload(); });
        return;
      }
      if (err.code === 'ROOM_FULL' || err.code === 'UNAUTHORIZED') {
        renderError(err.message, () => { location.href = GAME_HOME; });
        return;
      }
      /* 🔴 房码不存在必须**明确告知**，不能兜进 renderEntry()。
         2026-10-13 实测：后端 room.js:110 抛 {code:'ROOM_NOT_FOUND'}，
         而这里的分支只认 ROOM_FULL / UNAUTHORIZED，于是「房码不存在」
         落进最后的 renderEntry() —— 用户看到的是**完整入口页**，
         既不知道自己的房码已失效，URL 上还挂着 ?c=ZZZZZZZZ，
         看起来像页面坏了。表现与「点了没反应」几乎无法区分。
         注意：此时 URL 仍带失效房码，必须先清掉再跳，否则刷新会再次失败。 */
      if (err.code === 'ROOM_NOT_FOUND' || err.status === 404) {
        renderError(t('duel.room_not_found', 'That duel code does not exist. Check the code, or start a new duel.'),
          () => {
            try { history.replaceState(null, '', GAME_HOME); } catch (_) {}
            location.href = GAME_HOME;
          });
        return;
      }
      // 其余未知错误：也给出可读提示，不要无声吞掉
      renderError(t('duel.join_failed', 'Could not join that duel. Check the code and try again.'),
        () => { location.href = GAME_HOME; });
      return;
    }
  }

  renderEntry();
}

main().catch((e) => renderError((e as Error).message, () => location.reload()));