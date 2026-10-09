/**
 * MemoryDuel · Battle 页（M3 2026-10-01）
 * ────────────────────────────────────────────────────────────────
 * 教师邀请链接：https://memoryduel.com/?mode=battle&c=XXXXXX&tid=1
 * （home.ts 会在看到 ?mode=battle 时跳到 /battle/，query 全保留）
 *
 * 流程：
 *   1. 检测 tid=1 → classroom 邀请，弹代号输入
 *   2. ensureStudentCode(ic) → 调 /api/teacher/join 校核 → 落 localStorage
 *   3. 等题目加载（window.MemoryDuelQuiz.ready）→ 抽 10 题
 *   4. 每题 15 秒倒计时，逐题上报 reportRound
 *   5. 终局汇总 → outcome = solved >= 6 ? 'win' : 'loss'
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
      QUESTIONS: Array<{
        q: string;
        a: string | string[];
        c?: string;
        cat?: string;
        opts?: string[];
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

interface Question {
  q: string;
  a: string | string[];
  c?: string;
  cat?: string;
  opts?: string[];
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
  if (qEl) qEl.textContent = q.q;
  if (fbEl) fbEl.textContent = '';
  if (optsEl) optsEl.innerHTML = '';

  const correct = Array.isArray(q.a) ? q.a[0] : q.a;
  const opts = q.opts && q.opts.length ? q.opts : [correct, '__wrong1__', '__wrong2__', '__wrong3__'].slice(0, 4);
  // 把 correct + 三个干扰项打散
  const choices = shuffle([correct, ...opts.filter((o) => o !== correct).slice(0, 3)]);

  choices.forEach((choice, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bd-opt';
    b.dataset.choice = choice;
    b.dataset.idx = String(i);
    b.textContent = choice;
    b.addEventListener('click', () => onAnswer(choice === correct));
    optsEl?.appendChild(b);
  });

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
  if (scoreEl) scoreEl.textContent = `${solvedCount} / ${TOTAL} correct`;
  if (detailEl) {
    detailEl.textContent = pass
      ? `Pass · ${Math.round((solvedCount / TOTAL) * 100)}% · Your teacher will see this result.`
      : `Below threshold (${Math.round((solvedCount / TOTAL) * 100)}%) · Keep practicing!`;
  }
}

async function bootstrap() {
  const ic = urlRoomCode();
  if (!ic) {
    show('bd-result');
    const s = $<HTMLParagraphElement>('bd-result-score');
    if (s) s.textContent = 'No room code — open this page from your teacher’s invite link.';
    return;
  }
  roomCode = ic;
  const codeEl = $<HTMLSpanElement>('bd-code');
  if (codeEl) codeEl.textContent = ic;

  // M3（2026-10-01）：classroom 邀请链接先弹代号
  if (isClassroom()) {
    await ensureStudentCode(ic);   // 代号落 localStorage，后续 reportRound 自动取
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
    if (s) s.textContent = `Question pool is short (${questions.length}/${TOTAL}) — please ask your teacher.`;
    return;
  }

  startedAt = Date.now();
  currentIdx = 0;
  show('bd-stage');
  renderQuestion(questions[0], 0);
}

document.addEventListener('DOMContentLoaded', bootstrap);