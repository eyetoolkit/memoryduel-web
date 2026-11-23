/* ═══════════════════════════════════════════════════════════════
   首页「每日挑战」条 · 状态回填（P0-3，2026-11-24）
   ────────────────────────────────────────────────────────────────
   只做一件事：把 #arDailyCta / #arDailySub 换成今天的真实状态。

   🔴 三条红线：
     1. **绝不在首页新建会话**（不调 POST /api/md/session）。
        首页是流量最大的页面，每个访客建一个 session 会瞬间打爆
        RL_LIMIT_SESSION_NEW=5/分钟，直接导致「建房失败」全网出现。
        这里只读 localStorage 里**已有**的 md_session；没有就匿名请求，
        拿不到「我今天做过没有」也无所谓 —— 静默保留静态文案。
     2. 任何失败都不许冒泡：这是装饰性模块，挂了不能影响 hero 与 CTA。
     3. 文案双写（中/英），不依赖 i18n 字典新增键（字典版本号一动，
        六种语言全部要补，风险远大于收益）。
   ═══════════════════════════════════════════════════════════════ */

const API = '/api/md/kdaily/today';

function readSession() {
  try {
    const s = JSON.parse(localStorage.getItem('md_session') || 'null');
    if (s && s.pid && s.token) return s;
  } catch (e) { /* ignore */ }
  return null;
}

function lang() {
  try {
    if (window.i18n && window.i18n.getLang) return window.i18n.getLang();
  } catch (e) { /* ignore */ }
  const m = /[?&]lang=([a-z]{2})/.exec(location.search);
  if (m) return m[1];
  try { return (localStorage.getItem('md-lang') || 'en').slice(0, 2); } catch (e) { return 'en'; }
}

/**
 * @param {{played:boolean, score:number, correct:number, total:number, streak:number, players:number}} st
 */
function paint(st) {
  const cta = document.getElementById('arDailyCta');
  const sub = document.getElementById('arDailySub');
  if (!cta || !sub) return;
  const zh = lang() === 'zh';

  /* 🔴 先摘 data-i18n：i18n.js 有 MutationObserver，看到 textContent 变化会在
     60ms 后重跑 applyToDOM，把这里渲染的「今天已交卷 · 128 分」覆盖回静态文案。
     摘掉属性 = 这段节点的文案从此归本模块管。 */
  sub.removeAttribute('data-i18n');
  cta.removeAttribute('data-i18n');

  if (st.played) {
    cta.textContent = zh ? '查看今日成绩 →' : 'See today’s result →';
    cta.classList.add('done');
    const streakTxt = st.streak > 1 ? (zh ? ` · 连胜 ${st.streak} 天` : ` · ${st.streak}-day streak`) : '';
    sub.textContent = zh
      ? `今天已交卷 · 答对 ${st.correct}/${st.total} · ${st.score} 分${streakTxt}`
      : `Done for today · ${st.correct}/${st.total} correct · ${st.score} pts${streakTxt}`;
    return;
  }

  cta.textContent = zh ? '开始今天 →' : 'Play today →';
  if (st.streak > 0) {
    sub.textContent = zh
      ? `今日还没做 · 连胜 ${st.streak} 天，别断在今天${st.players ? ` · ${st.players} 人已参与` : ''}`
      : `Not started today · ${st.streak}-day streak on the line${st.players ? ` · ${st.players} played` : ''}`;
  } else if (st.players > 0) {
    sub.textContent = zh
      ? `十道题，一次机会 · 今天已有 ${st.players} 人参与`
      : `Ten questions, one attempt · ${st.players} played today`;
  }
}

async function init() {
  const el = document.getElementById('arDaily');
  if (!el) return;

  const s = readSession();
  const headers = { 'X-Lang': lang() };
  if (s) { headers['X-Player-ID'] = s.pid; headers['X-Player-Token'] = s.token; }

  try {
    const r = await fetch(API, { headers });
    const j = await r.json();
    if (!j || !j.ok || !j.data) return;
    const d = j.data;
    paint({
      played: !!d.played,
      score: (d.played && d.played.score) || 0,
      correct: (d.played && d.played.correct) || 0,
      total: d.total || 10,
      streak: d.streak || 0,
      players: d.players || 0,
    });
  } catch (e) { /* 装饰性模块，失败即保持静态文案 */ }
}

init();
