/**
 * MemoryDuel · Battle 页（M3 2026-10-01；公开入口 2026-10-14）
 * ────────────────────────────────────────────────────────────────
 * **两种模式，同一套引擎：**
 *
 *   A. 课堂局（教师邀请）
 *      https://memoryduel.com/?mode=battle&c=XXXXXX&tid=1
 *      home.ts 看到 ?mode=battle 会跳到本页，query 全保留。
 *      流程：检测 tid=1 → 弹代号 → ensureStudentCode(ic) 校核
 *            → 等题库加载 → 抽 10 题 → 每题 15s → reportRound 逐题上报
 *            → 终局 outcome = solved >= 6 ? 'win' : 'loss'
 *
 *   B. 公开自由局（无房码，2026-10-14 新增）
 *      https://memoryduel.com/battle/
 *      首页 Knowledge Duel 卡片与投放广告都走这条。出题 / 计时 / 判分 / 结算
 *      与课堂局完全一致，**只是不调用 reportRound**。
 *      原先无码直接跳终局并提示「从教师邀请链接进入」，导致首页导流过来
 *      是个死页面 —— 广告点进来 0 转化。这是 Knowledge Duel 不能投放的唯一卡点。
 *
 * 设计取舍：复用 quiz-data.js 的题目加载管线（同站 SEO 题库），不另起数据。
 */
import '../styles/battle.css';
import {
  isClassroom,
  urlRoomCode,
  reportRound,
  ensureStudentCode,
} from '../shared/teacher-track';

declare global {
  interface Window {
    MemoryDuelQuiz?: {
      CATEGORIES: ReadonlyArray<{ id: string; label: string }>;
      // 实际形状见下方 Question：qn/op 按语言分槽、ans 是下标
      QUESTIONS: Array<{
        cn?: string;
        diff?: number;
        qn?: Record<string, string>;
        op?: Record<string, string[]>;
        ans?: number;
        q?: string;
        options?: string[];
        _qid?: string;
        _rawLang?: string;
      }>;
      byCategory: (cat: string) => any[];
      ensureLoaded: () => Promise<{ total: number; categoriesOk: number }>;
      ready: boolean;
      getLang?: () => string;
      setLang?: (l: string) => void;
      detectLang?: () => string;
    };
  }
}

const TOTAL = 10;
const SECS_PER_Q = 15;
const PASS_THRESHOLD = 0.6;     // 60% 通过率

/** quiz-data.js 的**实际**契约（2026-10-14 修正）。
 *
 * 🔴 本页此前按一个早已废弃的形状在读：`a`（答案文本）、`opts`（选项数组）、`c`（分类）。
 *    quiz-data.js 的 `wrap()` 产出的其实是：
 *      qn: { [lang]: 题面 }   op: { [lang]: 选项[] }   ans: 正确选项**下标**(number)   cn: 分类 id
 *    于是 q.a / q.opts 全是 undefined → 掉进 `__wrong1__` 占位分支，
 *    界面上四个按钮显示 `__wrongN__` + 一个空按钮；
 *    更糟的是 `choice === correct` 恒为 false → **每一题都判错**，
 *    课堂局的 reportRound 也就把整局记成全错。
 *
 *    之所以一直没人发现：本页以前没有房码就直接跳终局（死页面），
 *    根本走不到出题这一步 —— 公开入口一开，这个休眠缺陷立刻现形。 */
interface Question {
  cn?: string;
  diff?: number;
  qn?: Record<string, string>;
  op?: Record<string, string[]>;
  ans?: number;
  q?: string;
  options?: string[];
  _rawLang?: string;
}

/** 取题面：优先当前语言槽位，回退 raw 便捷字段 */
function qText(q: Question, lang: string): string {
  return (q.qn && q.qn[lang]) || q.q || '';
}

/** 取选项：优先当前语言槽位，回退 raw 便捷字段 */
function qOptions(q: Question, lang: string): string[] {
  const slot = q.op && q.op[lang];
  return (slot && slot.length ? slot : (q.options || [])).slice();
}

/** 当前题库语言（与 quiz-data.js 的 LANG 同步） */
function curLang(): string {
  const Q = window.MemoryDuelQuiz;
  return (Q && Q.getLang && Q.getLang()) || 'en';
}

let questions: Question[] = [];
let roomCode = '';
let startedAt = 0;
let solvedCount = 0;
let answeredCount = 0;
let timerHandle: number | null = null;
let currentIdx = 0;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

function show(elId: string) {
  document.querySelectorAll<HTMLElement>('.bd-card').forEach((c) => (c.hidden = true));
  $(elId)?.removeAttribute('hidden');
}

function clearTimer() {
  if (timerHandle !== null) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 从题库抽 10 题：默认 general 分类；不足则跨分类补 */
function pickQuestions(): Question[] {
  const Q = window.MemoryDuelQuiz;
  if (!Q || Q.QUESTIONS.length === 0) return [];

  const curLang = (Q.getLang && Q.getLang()) || 'en';
  const general = (Q.byCategory('general') as Question[]).filter(
    (q: any) => !q._rawLang || q._rawLang === curLang,
  );
  let pool = general.slice();
  if (pool.length < TOTAL) {
    // 跨分类补足
    const ids = Q.CATEGORIES.map((c) => c.id);
    for (const id of ids) {
      if (id === 'general') continue;
      const more = (Q.byCategory(id) as Question[]).filter(
        (q: any) => !q._rawLang || q._rawLang === curLang,
      );
      pool = pool.concat(more);
      if (pool.length >= TOTAL * 2) break;
    }
  }
  return shuffle(pool).slice(0, TOTAL);
}

function renderQuestion(q: Question, idx: number) {
  const headEl = $<HTMLSpanElement>('bd-progress');
  const qEl = $<HTMLHeadingElement>('bd-question');
  const optsEl = $<HTMLDivElement>('bd-options');
  const fbEl = $<HTMLDivElement>('bd-feedback');
  if (headEl) headEl.textContent = `Q ${idx + 1} / ${TOTAL}`;
  if (qEl) qEl.textContent = qText(q, curLang());
  if (fbEl) fbEl.textContent = '';
  if (optsEl) optsEl.innerHTML = '';

  // 倒计时
  let remaining = SECS_PER_Q;
  const tEl = $<HTMLSpanElement>('bd-timer');
  if (tEl) tEl.textContent = `${remaining}s`;
  clearTimer();
  timerHandle = window.setInterval(() => {
    remaining -= 1;
    if (tEl) tEl.textContent = `${remaining}s`;
    if (remaining <= 0) {
      clearTimer();
      onAnswer(false);          // 超时算错
    }
  }, 1000);

  // 🔴 选项与正确答案来自 quiz-data 的 op[lang] / ans(下标)。
  //    打乱的是**下标**而不是文本，这样正确答案的位置才是随机的，
  //    且任何时候都有且只有一个正确项。
  const opts = qOptions(q, curLang());
  const correctIdx = Number(q.ans);
  if (!opts.length || !Number.isInteger(correctIdx) || opts[correctIdx] === undefined) {
    // 题库数据不完整：宁可跳过这题，也不要再渲染 __wrongN__ 之类的占位符给用户看
    console.error('[MD] battle: malformed question', { qid: (q as any)._qid, ans: q.ans, nOpts: opts.length });
    onAnswer(false);
    return;
  }

  shuffle(opts.map((_, i) => i)).forEach((oi) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bd-opt';
    b.dataset.choice = opts[oi];
    b.textContent = opts[oi];
    b.addEventListener('click', () => onAnswer(oi === correctIdx));
    optsEl?.appendChild(b);
  });
}

function onAnswer(correct: boolean) {
  clearTimer();
  answeredCount += 1;
  if (correct) solvedCount += 1;

  // 单题上报（每题一次 round，最细粒度；后端去重靠 round 序号）
  if (roomCode) {
    reportRound(roomCode, {
      round: answeredCount,
      solved: correct,
      duration_ms: SECS_PER_Q * 1000,
    });
  }

  // 显示反馈
  const fb = $<HTMLDivElement>('bd-feedback');
  if (fb) fb.textContent = correct ? '✓ Correct' : '✗ Incorrect';

  // 高亮选项（禁用按钮）
  document.querySelectorAll<HTMLButtonElement>('.bd-opt').forEach((b) => b.setAttribute('disabled', 'true'));

  // 1.4s 后进下一题
  setTimeout(() => {
    currentIdx += 1;
    if (currentIdx >= TOTAL) finish();
    else renderQuestion(questions[currentIdx], currentIdx);
  }, 1400);
}

function finish() {
  clearTimer();
  const elapsed = Date.now() - startedAt;
  const pass = solvedCount >= TOTAL * PASS_THRESHOLD;
  const outcome = pass ? 'win' : 'loss';

  // 终局汇总上报（额外 round=0 标记 'final'）
  if (roomCode) {
    reportRound(roomCode, {
      round: 0,                  // 0 = 终局汇总（服务端白名单：round 字段当前仅记录）
      solved: pass,
      duration_ms: elapsed,
      outcome,
    });
  }

  show('bd-result');
  const scoreEl = $<HTMLParagraphElement>('bd-result-score');
  const detailEl = $<HTMLParagraphElement>('bd-result-detail');
  const pct = Math.round((solvedCount / TOTAL) * 100);
  if (scoreEl) scoreEl.textContent = `${solvedCount} / ${TOTAL} correct`;
  if (detailEl) {
    if (roomCode) {
      // 课堂局：保留教师视角文案
      detailEl.textContent = pass
        ? `Pass · ${pct}% · Your teacher will see this result.`
        : `Below threshold (${pct}%) · Keep practicing!`;
    } else {
      // 公开自由局：🔴 绝不能出现 "Your teacher" —— 公开访客没有教师，
      // 那句话在投放落地页上既假又劝退。
      detailEl.textContent = pass
        ? `${pct}% · Sharp. Try to beat it.`
        : `${pct}% · Play again and beat it.`;
    }
  }
}

async function bootstrap() {
  const ic = urlRoomCode();
  /* 2026-10-14：房码改为**可选**。
   * 原来没有 ?c= 就直接跳终局并提示「从教师邀请链接进入」—— 那是课堂场景的设计，
   * 但 Knowledge Duel 卡片在首页面向所有访客导流到本页，无码进入就变成死页面，
   * 广告点进来 0 转化。现在无码 = **公开自由练习**：照常出题、计时、判分、结算，
   * 只是不调用 reportRound（下面所有上报本来就由 if (roomCode) 守着）。 */
  roomCode = ic || '';

  if (roomCode) {
    const codeEl = $<HTMLSpanElement>('bd-code');
    if (codeEl) codeEl.textContent = roomCode;
  } else {
    const roomEl = $<HTMLSpanElement>('bd-room');
    if (roomEl) roomEl.textContent = 'Free play';
  }

  // M3（2026-10-01）：classroom 邀请链接先弹代号（无房码的公开局不需要）
  if (roomCode && isClassroom()) {
    await ensureStudentCode(roomCode);   // 代号落 localStorage，后续 reportRound 自动取
  }

  // 等题目加载；同步 URL/站点语言（本页无 i18n，chrome 为英文，题库须跟 ?lang / storage）
  const Q = window.MemoryDuelQuiz;
  if (!Q) {
    show('bd-result');
    const s = $<HTMLParagraphElement>('bd-result-score');
    if (s) s.textContent = 'Quiz data failed to load — please refresh.';
    return;
  }
  try {
    const want = new URLSearchParams(location.search).get('lang');
    if (want && Q.setLang) Q.setLang(want);
    else if (Q.detectLang && Q.setLang) Q.setLang(Q.detectLang());
  } catch { /* ignore */ }
  try {
    await Q.ensureLoaded();
  } catch {
    /* 加载失败 → finish() 会因 questions=[] 自动跳终局 */
  }

  questions = pickQuestions();
  if (questions.length < TOTAL) {
    show('bd-result');
    const s = $<HTMLParagraphElement>('bd-result-score');
    if (s) s.textContent = roomCode
      ? `Question pool is short (${questions.length}/${TOTAL}) — please ask your teacher.`
      : `Question pool is short (${questions.length}/${TOTAL}) — please try again later.`;
    return;
  }

  startedAt = Date.now();
  currentIdx = 0;
  show('bd-stage');
  renderQuestion(questions[0], 0);
}

document.addEventListener('DOMContentLoaded', bootstrap);

/* 结算页「Play again」：直接重开一局。
 * 用 reload 而不是改 URL —— 课堂局要回到**同一个** ?c= 房间，
 * 公开局的 ?lang=en 也不能丢（否则题库语言会从 URL 回落到探测值）。 */
document.addEventListener('DOMContentLoaded', () => {
  $<HTMLButtonElement>('bd-replay')?.addEventListener('click', () => location.reload());
});