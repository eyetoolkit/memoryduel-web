/**
 * MemoryDuel · 每日挑战游戏页（P0-5 · 2026-10-12）
 * ────────────────────────────────────────────────────────────────
 * 页面模型（严格两层，game-mode-lobby-pattern）：
 *   /games/daily-challenge/lobby/   ← 大厅：纯 <a href> 卡片，无游戏逻辑
 *             │ ?mode=daily|number|sequence|color
 *             ▼
 *   /games/daily-challenge/         ← 本文件：读 ?mode= 入局
 *
 * 三种玩法（与后端 worker/src/sites/memoryduel/routes/daily.js 对齐）：
 *   number-recall   数字闪现 → 输入复现   3 轮，3/4/5 位，满分 12
 *   sequence-memory 格子依次点亮 → 按序点击 3 轮，3/4/5 格，满分 12
 *   color-recall    色块闪现 → 色轮还原   1 轮，5 色，满分 50
 *
 * 🔴 红线：
 *   · dateKey 服务端权威 —— 本文件全程不构造日期串，只读 today.date 展示
 *   · 答案永不由服务端回传 —— 判分结果只认 submit 的 score/correct
 *   · 无效 ?mode= 一律回大厅，不留在半死状态
 *   · 任何网络/解析错误都显性展示，绝不静默留白
 */

import '../styles/daily-challenge.css';
// window.DailyClient 的类型集中在 ../shared/daily-client.d.ts（单一真相源）
// `import type` = 纯类型导入，Vite 不会尝试解析 .d.ts 为运行时模块
import type {} from '../shared/daily-client';

const C = () => {
  const c = window.DailyClient;
  if (!c) throw new Error('daily-client.js 未加载');
  return c;
};

/* ─── DOM 助手 ─── */
const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel);

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] as string));
}

/** i18n 取值。
    🔴 i18n.t(key) 在缺 key 时**返回 key 本身**（见 public/i18n/i18n.js 的降级分支），
    所以不能靠"返回值非空"判断成功——那会把 `dc.num_h2` 直接显示给用户。
    这里显式识别降级：返回值 === key 就当没查到，退回英文兜底文案。 */
function t(key: string, fallback: string): string {
  const g = window as any;
  const fn = (typeof g.t === 'function' && g.t)
    || (g.i18n && typeof g.i18n.t === 'function' ? g.i18n.t.bind(g.i18n) : null);
  if (fn) {
    try {
      const val = fn(key);
      if (typeof val === 'string' && val && val !== key) return val;
    } catch (_) { /* 字典尚未加载完，走兜底 */ }
  }
  return fallback;
}

function announce(msg: string) {
  const live = $('#live');
  if (live) live.textContent = msg;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/* ─── 运行状态 ─── */
interface RunState {
  queue: string[];          // 待玩的关卡 id
  totals: Record<string, number>;   // 各关累计分
  perfect: boolean;
  streak: number;
  date: string;
}

let state: RunState = { queue: [], totals: {}, perfect: true, streak: 0, date: '' };

/* ─── 顶栏三关进度 ─── */
function renderSteps(current?: string) {
  const host = $('#steps');
  if (!host) return;
  const c = C();
  const doneMap = (window as any).__dcDone || {};
  host.innerHTML = c.GAME_ORDER.map((g) => {
    const meta = c.LEVELS[g];
    const cls = doneMap[g] ? 'ok' : (current === g ? 'on' : '');
    const mark = doneMap[g] ? '✓' : '·';
    return `<span class="dc-step ${cls}"><span class="n">${mark}</span>${esc(meta.icon)} ${esc(t(`dc.${g}`, g))}</span>`;
  }).join('');
}

function setDone(game: string, ok: boolean) {
  (window as any).__dcDone = (window as any).__dcDone || {};
  (window as any).__dcDone[game] = ok;
}

/* ─── 错误展示（永不静默留白）─── */
function renderError(msg: string, retry?: () => void) {
  const card = $('#card');
  if (!card) return;
  card.innerHTML = `
    <h2 class="dc-h2">${esc(t('dc.err_title', 'Something went wrong'))}</h2>
    <p class="dc-help">${esc(t('dc.err_hint', 'The challenge could not load. This is usually temporary.'))}</p>
    <div class="dc-err">${esc(msg)}</div>
    ${retry ? `<button class="dc-btn" id="retryBtn" type="button">${esc(t('dc.retry', 'Try again'))}</button>` : ''}
    <a class="dc-btn ghost" href="${C().LOBBY_URL}" style="margin-top:10px;display:block;text-align:center;text-decoration:none">
      ${esc(t('dc.game_back', '← All modes'))}
    </a>`;
  const rb = document.getElementById('retryBtn');
  if (rb && retry) rb.addEventListener('click', retry);
}

/* ═══════════════════════════════════════════════════════════════
   Number Recall —— 数字闪现 → 输入复现
   🔴 返回玩家**实际输入**（服务端据此判分），不是正确答案
   ═══════════════════════════════════════════════════════════════ */
async function playNumber(puzzle: any): Promise<{ answer: string }> {
  const digits: number[] = puzzle.digits || [];
  const s = String(digits.join(''));

  const card = $('#card')!;
  card.innerHTML = `
    <h2 class="dc-h2">${esc(t('dc.num_h2', 'Number Recall'))}</h2>
    <p class="dc-help">${esc(t('dc.num_help', 'Watch the digits, then type them from memory.'))}</p>
    <div class="dc-num-stage hide" id="stage" aria-live="off">${esc(s)}</div>
    <input class="dc-input" id="ans" inputmode="numeric" autocomplete="off"
           maxlength="${digits.length}" placeholder="${'0'.repeat(digits.length)}"
           aria-label="${esc(t('dc.num_aria', 'Digits you remember'))}" disabled />
    <button class="dc-btn" id="go" type="button" style="margin-top:14px">${esc(t('dc.num_ready', 'I am ready'))}</button>`;

  const stage = $('#stage') as HTMLElement;
  const go = $('#go') as HTMLButtonElement;
  const ans = $('#ans') as HTMLInputElement;

  await new Promise<void>((resolve) => {
    go.addEventListener('click', () => resolve(), { once: true });
  });

  go.disabled = true;
  go.style.display = 'none';

  // 逐位闪现（记忆类游戏的感知编码，节奏化比一次性呈现更接近范式）
  for (let i = 0; i < s.length; i++) {
    stage.textContent = s[i];
    stage.classList.remove('hide', 'show');
    void stage.offsetWidth;   // 强制重排以重启动画
    stage.classList.add('show');
    await sleep(600);
  }
  // 整串再展示一拍，然后抹掉
  stage.textContent = s;
  void stage.offsetWidth;
  stage.classList.add('show');
  await sleep(1100);
  stage.textContent = '';
  stage.classList.add('hide');
  stage.classList.remove('show');

  ans.disabled = false;
  ans.focus();

  const typed = await new Promise<string>((resolve) => {
    ans.addEventListener('input', () => {
      ans.value = ans.value.replace(/\D/g, '').slice(0, digits.length);
      if (ans.value.length === digits.length) resolve(ans.value);
    });
    ans.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && ans.value.length) resolve(ans.value);
    });
  });

  return { answer: typed };
}

/* ═══════════════════════════════════════════════════════════════
   Sequence Memory —— 格子依次点亮 → 按序点击
   🔴 返回玩家**实际点击序列**，不是正确答案
   ═══════════════════════════════════════════════════════════════ */
async function playSequence(puzzle: any): Promise<{ answer: number[] }> {
  const seq: number[] = (puzzle.seq || []).map((n: number) => Number(n));
  const grid = Number(puzzle.grid) || 3;
  const size = grid * grid;

  const card = $('#card')!;
  const cells = Array.from({ length: size }, (_, i) => `<button class="dc-seq-cell" type="button" data-i="${i}" aria-label="${i + 1}"></button>`).join('');
  card.innerHTML = `
    <h2 class="dc-h2">${esc(t('dc.seq_h2', 'Sequence Memory'))}</h2>
    <p class="dc-help">${esc(t('dc.seq_help', 'Tiles light up one by one. Tap them back in the same order.'))}</p>
    <div class="dc-seq-grid" id="grid" style="grid-template-columns:repeat(${grid},1fr)">${cells}</div>
    <button class="dc-btn" id="go" type="button">${esc(t('dc.seq_ready', 'Show me'))}</button>`;

  const gridEl = $('#grid')!;
  const go = $('#go') as HTMLButtonElement;
  const nodes = Array.from(gridEl.querySelectorAll<HTMLElement>('.dc-seq-cell'));

  await new Promise<void>((resolve) => {
    go.addEventListener('click', () => resolve(), { once: true });
  });
  go.disabled = true;
  go.style.display = 'none';
  nodes.forEach((n) => n.setAttribute('disabled', ''));

  // 依次点亮
  for (const idx of seq) {
    nodes[idx].classList.add('lit');
    await sleep(600);
    nodes[idx].classList.remove('lit');
    await sleep(240);
  }
  await sleep(400);

  // 🔴 演示结束必须解除 disabled，否则玩家点了没反应（第一版漏了这步，格子永久禁用）
  nodes.forEach((n) => n.removeAttribute('disabled'));

  // 按序点击
  const picked: number[] = [];
  await new Promise<void>((resolve) => {
    const onClick = (e: Event) => {
      const el = (e.target as HTMLElement).closest('.dc-seq-cell') as HTMLElement | null;
      if (!el) return;
      const i = Number(el.dataset.i);
      picked.push(i);
      el.classList.add(i === seq[picked.length - 1] ? 'lit' : 'wrong');
      setTimeout(() => el.classList.remove('lit', 'wrong'), 220);
      if (picked.length === seq.length) {
        gridEl.removeEventListener('click', onClick);
        resolve();
      }
    };
    gridEl.addEventListener('click', onClick);
  });

  return { answer: picked };
}

/* ═══════════════════════════════════════════════════════════════
   Color Recall —— 色块闪现 → 色轮还原
   🔴 返回玩家调好的 HSB 数组，服务端按同一公式复算给权威分
   ═══════════════════════════════════════════════════════════════ */
function hsbToCss(h: number, s: number, b: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(b)}%)`;
}

async function playColor(puzzle: any): Promise<{ answer: Array<{ h: number; s: number; b: number }> }> {
  const colors: Array<{ h: number; s: number; b: number }> = puzzle.colors || [];

  const card = $('#card')!;
  card.innerHTML = `
    <h2 class="dc-h2">${esc(t('dc.col_h2', 'Colour Recall'))}</h2>
    <p class="dc-help">${esc(t('dc.col_help', 'Five colours appear, then vanish. Rebuild each one as closely as you can.'))}</p>
    <div class="dc-color-row" id="row"></div>
    <button class="dc-btn" id="go" type="button">${esc(t('dc.col_ready', 'I am ready'))}</button>`;

  const row = $('#row')!;
  const go = $('#go') as HTMLButtonElement;

  await new Promise<void>((resolve) => {
    go.addEventListener('click', () => resolve(), { once: true });
  });

  row.innerHTML = colors
    .map((c) => `<div class="dc-color-swatch" style="background:${hsbToCss(c.h, c.s, c.b)}"></div>`)
    .join('');
  await sleep(4200);
  row.innerHTML = '';

  // 逐色还原：显示目标色 → 在色轮/滑块上调色
  const answers: Array<{ h: number; s: number; b: number }> = [];

  for (let i = 0; i < colors.length; i++) {
    const tgt = colors[i];
    const target = hsbToCss(tgt.h, tgt.s, tgt.b);

    card.innerHTML = `
      <h2 class="dc-h2">${esc(t('dc.col_h2', 'Colour Recall'))}</h2>
      <p class="dc-help">${esc(t('dc.col_pick', `Colour ${i + 1} of ${colors.length} — match it as closely as you can.`)
        .replace('{n}', String(i + 1))
        .replace('{total}', String(colors.length)))}</p>
      <div class="dc-color-target" style="width:100%;height:120px;background:${target}" aria-label="${esc(t('dc.col_target', 'Target colour'))}"></div>
      <div class="dc-wheel" id="wheel" style="background:conic-gradient(from 0deg,#FF0000,#FFFF00,#00FF00,#00FFFF,#0000FF,#FF00FF,#FF0000)"
           role="application" aria-label="${esc(t('dc.col_wheel', 'Colour wheel'))}"></div>
      <p class="dc-wheel-hint">${esc(t('dc.col_hint', 'Click or drag on the wheel to set hue and lightness; use the sliders for saturation.'))}</p>
      <div class="dc-sliders">
        <div class="dc-slider-row"><span>H</span><input type="range" id="h" min="0" max="359" value="${Math.round(tgt.h)}" /><output id="ho">${Math.round(tgt.h)}</output></div>
        <div class="dc-slider-row"><span>S</span><input type="range" id="s" min="20" max="100" value="${Math.round(tgt.s)}" /><output id="so">${Math.round(tgt.s)}</output></div>
        <div class="dc-slider-row"><span>B</span><input type="range" id="b" min="10" max="95" value="${Math.round(tgt.b)}" /><output id="bo">${Math.round(tgt.b)}</output></div>
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

    // 点色轮 → 换算成 HSL（色相=角度，明度按半径衰减）
    const wheelPick = (e: PointerEvent) => {
      const r = wheel.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const dist = Math.hypot(dx, dy) / (r.width / 2);
      if (dist < 0.08) return;   // 中心是灰盘，忽略
      let deg = Math.atan2(dy, dx) * (180 / Math.PI);
      if (deg < 0) deg += 360;
      h.value = String(Math.round(deg) % 360);
      const nv = Math.round(95 - Math.min(dist, 1) * 85);   // 越靠边越暗
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

  // 本地估分仅用于即时反馈；权威分数一律以服务端 submit 返回的 score 为准
  return { answer: answers };
}

/* ═══════════════════════════════════════════════════════════════
   单轮结果
   ═══════════════════════════════════════════════════════════════ */
async function showRoundResult(game: string, server: any) {
  const c = C();
  const meta = c.LEVELS[game];
  const card = $('#card')!;
  // 🔴 单轮满分 ≠ 关卡满分：number/sequence 单轮满分是 3/4/5，关卡满分才是 12。
  //    拿 meta.maxScore 去比单轮分数，会让「本轮满分」永远不显示。
  const roundCap = c.roundMax(game, server.round);
  const perfect = server.score >= roundCap;

  card.innerHTML = `
    <h2 class="dc-h2">${esc(perfect ? t('dc.perfect', 'Perfect round!') : t('dc.round_done', 'Round complete'))}</h2>
    <div class="dc-result-score">${server.score}</div>
    <div class="dc-result-of">${esc(t('dc.of_max', 'of'))} ${roundCap}</div>
    ${perfect ? `<div class="dc-streak">🔥 ${esc(t('dc.full_marks', 'Full marks'))}</div>` : ''}
    <div class="dc-rank">
      <div class="dc-rank-row"><span class="ico">${meta.icon}</span><span class="nm">${esc(t(`dc.${game}`, game))}</span><span class="sc">${server.total}</span></div>
    </div>
    <button class="dc-btn" id="nextBtn" type="button">${esc(t('dc.next', 'Continue'))}</button>`;

  announce(`${server.score} / ${roundCap}`);
  await new Promise<void>((resolve) => {
    document.getElementById('nextBtn')!.addEventListener('click', () => resolve(), { once: true });
  });
}

/* ═══════════════════════════════════════════════════════════════
   终局
   ═══════════════════════════════════════════════════════════════ */
async function showFinal() {
  const c = C();
  const card = $('#card')!;

  let streak = state.streak;
  try { streak = (await c.fetchStreak()).streak; } catch (_) { /* 用提交时返回的值兜底 */ }
  state.streak = streak;

  const rows = c.GAME_ORDER.map((g) => {
    const meta = c.LEVELS[g];
    const got = state.totals[g] || 0;
    const done = got >= meta.maxScore;
    return `<div class="dc-rank-row ${done ? '' : ''}">
      <span class="ico">${meta.icon}</span>
      <span class="nm">${esc(t(`dc.${g}`, g))}</span>
      <span class="sc">${got} / ${meta.maxScore}</span>
    </div>`;
  }).join('');

  const sum = Object.values(state.totals).reduce((a, b) => a + b, 0);
  const max = c.GAME_ORDER.reduce((a, g) => a + c.LEVELS[g].maxScore, 0);

  card.innerHTML = `
    <h2 class="dc-h2">${esc(t('dc.final_title', "Today's challenge complete"))}</h2>
    <div class="dc-result-score">${sum}</div>
    <div class="dc-result-of">${esc(t('dc.of_max', 'of'))} ${max}${state.perfect ? ' · ' + esc(t('dc.perfect_all', 'all levels maxed')) : ''}</div>
    <div class="dc-streak">🔥 ${esc(t('dc.streak_days', 'Day streak'))}: ${streak}</div>
    <div class="dc-rank">${rows}</div>
    <button class="dc-btn" id="againBtn" type="button">${esc(t('dc.play_again', 'Play again'))}</button>
    <a class="dc-btn ghost" href="${c.LOBBY_URL}" style="margin-top:10px;display:block;text-align:center;text-decoration:none">
      ${esc(t('dc.game_back', '← All modes'))}
    </a>`;

  announce(`${sum} / ${max}`);

  document.getElementById('againBtn')!.addEventListener('click', () => {
    location.reload();
  });
}

/* ═══════════════════════════════════════════════════════════════
   主流程
   ═══════════════════════════════════════════════════════════════ */
async function runLevel(game: string, startRound: number) {
  const c = C();
  const meta = c.LEVELS[game];
  if (!meta) { location.replace(c.LOBBY_URL); return; }

  for (let round = startRound; round <= meta.rounds; round++) {
    renderSteps(game);

    let puzzle: any;
    try {
      puzzle = (await c.fetchPuzzle(game, round)).puzzle;
    } catch (e) {
      renderError((e as Error).message, () => { runLevel(game, round); });
      return;
    }

    let played: { answer: unknown };
    try {
      if (game === 'number-recall')   played = await playNumber(puzzle);
      else if (game === 'sequence-memory') played = await playSequence(puzzle);
      else played = await playColor(puzzle);
    } catch (e) {
      renderError((e as Error).message, () => { runLevel(game, round); });
      return;
    }

    let server: any;
    try {
      // 🔴 提交玩家真实作答，服务端用同 seed 复算判分
      server = await c.submitAnswer(game, round, played.answer);
    } catch (e) {
      renderError((e as Error).message, () => { runLevel(game, round); });
      return;
    }

    // 分数一律取服务端返回值，客户端不自行判分。
    // 🔴 用 server.total（服务端每轮只留最好成绩的累计值）而不是本地累加：
    //    本地累加在「同一轮重试」时会重复计数，终局总分虚高、perfect 被误判。
    state.totals[game] = Number.isFinite(server.total) ? server.total : (state.totals[game] || 0) + server.score;
    state.streak = server.streak;
    // 🔴 perfect 是**服务端按整关累计**判定的（total >= 关卡满分），
    //    不能用「本轮分数 == 关卡满分」重算，否则三轮 3+4+5=12 也判不出来。
    if (typeof server.perfect === 'boolean') {
      state.perfect = state.perfect && server.perfect;
    } else {
      state.perfect = state.perfect && server.score >= c.roundMax(game, round);
    }
    setDone(game, true);

    await showRoundResult(game, server);
  }
}

/* ═══════════════════════════════════════════════════════════════
   主流程
   ═══════════════════════════════════════════════════════════════ */

async function main() {
  // 🔴 等待契约层就绪（普通 script 加载，可能晚于本模块）
  for (let i = 0; i < 50 && !window.DailyClient; i++) await sleep(40);
  if (!window.DailyClient) {
    renderError('[daily-client] /shared/daily-client.js 未加载，无法与后端通信');
    return;
  }
  const c = C();

  // 1) 深链解析：无效 mode 一律回大厅，不留在半死状态
  const params = new URLSearchParams(location.search);
  // 邀请码优先（与全站约定一致）：?c= 优先于 ?mode=
  const invite = params.get('c') || params.get('room');
  if (invite) { location.replace(`${c.LOBBY_URL}?c=${encodeURIComponent(invite)}`); return; }

  const mode = c.resolveMode(params.get('mode'));
  if (!mode) { location.replace(c.LOBBY_URL); return; }

  // 2) 先取今日元信息（顺便确认后端可达）
  let today: any;
  try {
    today = await c.fetchToday();
  } catch (e) {
    renderError((e as Error).message, () => { main(); });
    return;
  }
  state.date = today.date;
  state.streak = today.streak || 0;
  (window as any).__dcDone = {};
  renderSteps(mode.game);

  // 3) 单关模式：只玩这一关，结束进终局页
  if (mode.queue.length === 1) {
    await runLevel(mode.game, mode.round);
    await showFinal();
    return;
  }

  // 4) 每日三关：依次通关
  for (const g of mode.queue) {
    await runLevel(g, 1);
    if (!(window as any).__dcDone[g]) return;   // 出错已渲染，等用户重试
  }
  await showFinal();
}

void main();
