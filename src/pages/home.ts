/**
 * MemoryDuel 首页 · 暖纸皮肤装配层
 * ---------------------------------------------------------------------------
 * 设计稿：design-reference/memoryduel-homepage-papergames.html
 * CSS：   src/styles/home-papergames.css（body.home-v2 作用域）
 *
 * 分工：
 *   · 对战逻辑（模式切换 / 分类 / 匹配 / 房间）由 public/assets/js/home.mjs 负责，
 *     本文件不重复实现，只做皮肤层的三件事：
 *       1. 抽屉导航 + 侧栏收窄
 *       2. 真实排行榜（POST /api/md/session → GET /api/md/rank）
 *       3. 发布阶段兜底（防 CDN 缓存住带 beta 入口的旧 HTML）
 *
 * 关于 API 基址：本站 CSP 的 connect-src 只有 'self'，account/Quiz 都在同源
 * /api/md/* 下。历史上 index.html 把 window.API_BASE 设成了 api.memoryduel.com
 * （跨源，会被 CSP 拦），现在删掉了那个 head 脚本 —— 各处 `window.API_BASE || ''`
 * 自然落到同源请求。
 */

const SHOW_BETA = import.meta.env.VITE_SHOW_BETA === '1';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

/* ── 1. 阶段兜底 ────────────────────────────────────────────────────── */
if (!SHOW_BETA) {
  document.querySelectorAll<HTMLElement>('[data-stage="beta"]').forEach((el) => el.remove());
}

/* ── 2. 抽屉 / 收窄导航 ─────────────────────────────────────────────── */
function bindNav(): void {
  const burger = $<HTMLButtonElement>('burger');
  const overlay = $('overlay');
  const collapse = $<HTMLButtonElement>('collapse');

  const close = () => {
    document.body.classList.remove('nav-open');
    burger?.setAttribute('aria-expanded', 'false');
  };

  burger?.addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    burger.setAttribute('aria-expanded', String(open));
  });
  overlay?.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  collapse?.addEventListener('click', () => document.body.classList.toggle('rail'));

  // 抽屉里点任何导航项都收起来，否则在手机上会挡住锚点目标
  document.querySelectorAll<HTMLAnchorElement>('.sidebar .nav-item').forEach((a) => {
    a.addEventListener('click', () => {
      if (window.matchMedia('(max-width: 1119px)').matches) close();
    });
  });
}

/* ── 3. 真实排行榜 ──────────────────────────────────────────────────── */
interface Session {
  pid: string;
  token: string;
}

interface RankRow {
  name?: string;
  rating?: number;
  tier?: string;
}

const SESSION_KEY = 'md_session';
let sessionPromise: Promise<Session | null> | null = null;

function getSession(): Promise<Session | null> {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    try {
      const cached = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as Session | null;
      if (cached && cached.pid && cached.token) return cached;
    } catch {
      /* 忽略坏掉的本地缓存 */
    }
    try {
      const res = await fetch('/api/md/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const json = (await res.json()) as { ok?: boolean; data?: Session };
      if (!json.ok || !json.data?.pid || !json.data?.token) return null;
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(json.data));
      } catch {
        /* 隐私模式写不进去也没关系，本次请求照样带得上 */
      }
      return json.data;
    } catch {
      return null;
    }
  })();
  return sessionPromise;
}

function rowHtml(i: number, p: RankRow): string {
  const cls = ['rank-row'];
  if (i === 0) cls.push('top1');
  if (i === 1) cls.push('top2');
  if (i === 2) cls.push('top3');
  return (
    `<div class="${cls.join(' ')}">` +
    `<span class="rank-no">${i + 1}</span>` +
    `<span class="rank-av"></span>` +
    `<span class="rank-nm"></span>` +
    `<span class="rank-pt">${Number(p.rating ?? 0)}</span>` +
    `</div>`
  );
}

async function loadRank(): Promise<void> {
  const list = $('topRankList');
  if (!list) return;

  const empty = (text: string) => {
    list.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'rank-empty';
    div.textContent = text;
    list.appendChild(div);
  };

  try {
    const s = await getSession();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (s) {
      headers['X-Player-ID'] = s.pid;
      headers['X-Player-Token'] = s.token;
    }
    const res = await fetch('/api/md/rank?limit=6', { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { ok?: boolean; data?: { list?: RankRow[] } };
    const rows = json.ok && Array.isArray(json.data?.list) ? json.data!.list!.slice(0, 6) : [];

    if (!rows.length) {
      empty('No ranked players yet — win your first duel to appear here.');
      return;
    }

    list.innerHTML = rows.map((p, i) => rowHtml(i, p)).join('');
    // 昵称/首字母用 textContent 写，避免把用户可控字符串拼进 HTML
    list.querySelectorAll<HTMLElement>('.rank-row').forEach((el, i) => {
      const name = rows[i]?.name || `Player ${i + 1}`;
      const nm = el.querySelector('.rank-nm');
      const av = el.querySelector('.rank-av');
      if (nm) nm.textContent = name;
      if (av) av.textContent = name.slice(0, 1).toUpperCase();
    });
  } catch {
    empty('Rankings unavailable right now.');
  }
}

/* ── 4. Online 模式钩子（重设计交付包 README §1 的 ?mode=online 契约） ──
 * 深链 ?mode=online 预激活 Online tab；「Find an online match」CTA 点击也切到 Online。
 * 依赖：home.mjs 先行加载并完成 bindModeToggle（script 顺序保证），这里只需模拟点击。
 */
function bindModeHooks(): void {
  const onlineTab = document.querySelector<HTMLButtonElement>('#modeToggle [data-m="online"]');
  if (!onlineTab) return;
  const activate = () => onlineTab.click();
  /* 深链激活必须等 home.mjs 绑好监听：构建后本模块被 vite 提到 <head>，
     模块按文档顺序执行时 home.mjs（body 末尾）还没跑，立即 click 会落空。 */
  if (new URLSearchParams(location.search).get('mode') === 'online') {
    if (document.readyState === 'complete') activate();
    else window.addEventListener('load', activate, { once: true });
  }
  document.querySelectorAll<HTMLAnchorElement>('a[href="#online"]').forEach((a) => {
    a.addEventListener('click', activate);
  });
}

bindNav();
bindModeHooks();
void loadRank();

/* ── 5. M3（2026-10-01）：教师邀请深链 ?mode=battle&c=XXX&tid=1 ──
 * 教师在 numeriduel.com 控制台生成的 memoryduel 邀请链接
 *   https://memoryduel.com/?mode=battle&c=ABC123&tid=1
 * 落地到 memoryduel 首页后跳转到 /battle/，query 全保留。
 * 必须发生在 bindModeHooks() 之后（bindNav 已绑好再跳转更稳）。 */
(function deepLinkToBattle() {
  const p = new URLSearchParams(location.search);
  if (p.get('mode') !== 'battle') return;
  if (!p.get('c')) return;                  // 无房间码 → 不跳
  // 一次性跳转，跳完把 URL 改成 /battle/ 让刷新行为一致
  location.replace('/battle/' + location.search);
})();
