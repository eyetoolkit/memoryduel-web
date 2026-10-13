/**
 * MemoryDuel · 每日挑战大厅页（P0-5 · 2026-10-12）
 * ────────────────────────────────────────────────────────────────
 * 大厅页只做两件事：
 *   1. 展示今日三关的真实完成状态（拉 /api/md/daily/today，失败则静默留原样）
 *   2. 无效 ?mode= 深链回退到本页（游戏页负责入局，这里不跑游戏逻辑）
 *
 * 🔴 诚信铁律：侧栏只显示后端真实返回的数据。
 *   today 拉不到就保持 HTML 里的静态占位，**绝不 mock 一个假的分数或 streak**。
 */

// window.DailyClient 的类型集中在 ../shared/daily-client.d.ts，
// 这里用 `import type` 纯类型导入：既把声明纳入 TS 编译单元，
// 又不让 Vite 去找一个运行时并不存在的 .d.ts 模块。
import type {} from '../shared/daily-client';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] as string));
}

/** i18n 取值（与 daily-game.ts 同一套降级识别：
    i18n.t() 缺 key 时返回 key 本身，不能靠「非空」判断成功） */
function t(key: string, fallback: string): string {
  const g = window as any;
  const fn = (typeof g.t === 'function' && g.t)
    || (g.i18n && typeof g.i18n.t === 'function' ? g.i18n.t.bind(g.i18n) : null);
  if (fn) {
    try {
      const val = fn(key);
      if (typeof val === 'string' && val && val !== key) return val;
    } catch (_) { /* 字典未加载完，走兜底 */ }
  }
  return fallback;
}

async function main() {
  // 🔴 无效 mode 深链：直接回大厅，避免停在一个什么都不做的页面
  //    合法值交给契约层 resolveMode() 判定 —— 单一真相源，不在页面重抄一份。
  //    硬编码列表漏一个 mode（如 P2 新增的 emoji/chimp/word），
  //    玩家点大厅卡片过来会被静默踢回大厅，且看不出哪里错。
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  if (mode && !window.DailyClient) {
    location.replace('/games/daily-challenge/lobby/');
    return;
  }
  if (mode && window.DailyClient && !window.DailyClient.resolveMode(mode)) {
    location.replace('/games/daily-challenge/lobby/');
    return;
  }

  // 等契约层就绪
  for (let i = 0; i < 50 && !window.DailyClient; i++) await sleep(40);
  if (!window.DailyClient) return;
  const c = window.DailyClient;

  let today: Awaited<ReturnType<typeof c.fetchToday>>;
  try {
    today = await c.fetchToday();
  } catch (e) {
    // 🔴 拉不到就保持 HTML 原样：不显示假数据，也不在大厅页制造噪音
    console.warn('[daily-lobby] today 拉取失败，侧栏保持静态占位：', (e as Error).message);
    return;
  }

  // 侧栏：真实完成态 + 分数
  const host = document.getElementById('lvRows');
  if (host) {
    /* 🔴 关卡名与图标一律取自契约层 LEVELS + i18n，不再在页面上手抄一份。
       硬编码的后果：P2 加了三款新关，这里仍只认老三关，
       侧栏会把 emoji-ghost 显示成「Colour Recall」（图标和名字都错），
       而且**不报错** —— 轮换队列抽到新关时玩家看到的是错的关卡名。 */
    host.innerHTML = today.levels.map((l) => {
      const done = !!today.done[l.game];
      const sc = (today.score && (today.score as any)[l.game]) || 0;
      const meta = c.LEVELS[l.game];
      const icon = (meta && meta.icon) || '🧠';
      const name = t(`dc.${l.game}`, l.game);
      return `<div class="dc-side-row ${done ? 'done' : ''}">
        <span class="ico">${done ? '✅' : esc(icon)}</span>
        <span class="nm">${esc(name)}</span>
        <span class="sc">${done ? `${sc} / ${l.maxScore}` : l.maxScore}</span>
      </div>`;
    }).join('');
  }

  // 🔴 诚实铁律：全部完成才显示连胜，否则不假装有 streak
  const allDone = today.levels.every((l) => today.done[l.game]);
  const chipHost = document.querySelector('.dc-chips');
  if (chipHost && allDone && today.streak > 0) {
    chipHost.insertAdjacentHTML('beforeend',
      `<span class="chip" style="border-color:#16A34A;color:#15803D">
         <span class="dot" style="background:#16A34A"></span>🔥 Day streak: ${today.streak}
       </span>`);
  }
}

void main();
