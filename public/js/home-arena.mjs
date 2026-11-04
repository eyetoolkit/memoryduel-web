/* ═══════════════════════════════════════════════════════════════
   MemoryDuel 首页 · Arena 首屏交互（2026-11-04）
   ---------------------------------------------------------------------------
   职责仅两件，不触碰对战引擎、不重复 home.mjs 的任何逻辑：
     1. 首屏「真实对战卡」演示：15s 倒计时 / 回合推进 / 选项反馈
     2. 旧深链 ?mode=online 在首页无模式 tab 后改落到大厅页
   🔴 applyToDOM 会冲写带 data-i18n 的 JS 节点 —— 时钟/回合数一律不挂
      data-i18n，只由本模块写 textContent。
   ═══════════════════════════════════════════════════════════════ */

const $ = (s, r) => (r || document).querySelector(s);

/* ── 1. Online 深链（首页已无模式面板） ── */
(function redirectOnlineDeepLink() {
  const p = new URLSearchParams(location.search);
  if (p.get('mode') !== 'online') return;
  location.replace('/games/knowledge-duel/lobby/?mode=online');
})();

/* ── 2. 对战卡演示 ── */
(function liveDuelCard() {
  const clockNum = $('#arClockNum');
  const clockBar = $('#arClockBar');
  const roundNum = $('#arRoundNum');
  const opts = Array.from(document.querySelectorAll('.ar-opt'));
  if (!clockNum || !clockBar || !opts.length) return;

  let left = 15;
  let round = 1;
  let timer = null;
  let pausedUntil = 0;

  function paintClock() {
    clockNum.textContent = left + 's';
    clockBar.style.width = Math.max(0, (left / 15) * 100) + '%';
    clockBar.style.background = left <= 5 ? '#FF6B5C' : '#F5B300';
  }

  function nextRound() {
    round = round >= 10 ? 1 : round + 1;
    if (roundNum) roundNum.textContent = String(round);
    opts.forEach((o) => {
      o.classList.remove('wrong');
      const tick = $('.ar-tick', o);
      if (tick) tick.remove();
    });
    left = 15;
    paintClock();
  }

  function stop() { clearInterval(timer); timer = null; }
  function start() {
    if (timer || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    timer = setInterval(() => {
      if (Date.now() < pausedUntil) return;
      left -= 1;
      paintClock();
      if (left <= 0) nextRound();
    }, 1000);
  }

  opts.forEach((o) => {
    o.addEventListener('click', () => {
      if (o.classList.contains('correct')) {
        o.setAttribute('aria-label', 'Correct answer');
      } else {
        o.classList.add('wrong');
      }
      pausedUntil = Date.now() + 1400;
      setTimeout(() => o.classList.remove('wrong'), 1300);
    });
  });

  paintClock();
  start();
})();
