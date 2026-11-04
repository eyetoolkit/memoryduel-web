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

/* ── 3. 首屏题量：接真实 /api/md/quiz/counts（2026-11-04 P1-2） ──
   旧版 46,000+ 是方向 A 落地时写死的静态文案，与 D1 真实 26 万题库脱节。
   端点在上轮 P0-b 已改成 D1 真实口径，这里读「当前语言」的合计，
   切语言时跟着重取；接口失败保留静态兜底，绝不闪空白或 NaN。
   🔴 该节点不挂 data-i18n（JS 写的 textContent/innerHTML 会被 applyToDOM 冲回）。 */
(function liveQuestionCount() {
  const el = document.getElementById('arQuestionCount');
  if (!el) return;
  let lastLang = '';
  function paint(langOverride) {
    const lang = String(langOverride || document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
    if (!lang || lang === lastLang) return;
    lastLang = lang;
    fetch('/api/md/quiz/counts?lang=' + encodeURIComponent(lang))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const c = j && ((j.data && j.data.counts) || j.counts);
        if (!c || typeof c !== 'object') return;
        const total = Object.values(c).reduce((a, b) => a + (Number(b) || 0), 0);
        if (total > 0) el.innerHTML = total.toLocaleString('en-US') + '<span>+</span>';
      })
      .catch(() => { /* 保留静态兜底 */ });
  }
  paint();
  window.addEventListener('i18n:change', (ev) => paint(ev.detail && ev.detail.lang));
  window.addEventListener('i18n:ready', (ev) => paint(ev.detail && ev.detail.lang));
})();
