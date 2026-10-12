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

async function main() {
  // 🔴 无效 mode 深链：直接回大厅，避免停在一个什么都不做的页面
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  if (mode) {
    const valid = ['daily', 'number', 'sequence', 'color'];
    if (!valid.includes(mode.toLowerCase())) {
      location.replace('/games/daily-challenge/lobby/');
      return;
    }
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
    host.innerHTML = today.levels.map((l) => {
      const done = !!today.done[l.game];
      const sc = (today.score && (today.score as any)[l.game]) || 0;
      const icon = l.game === 'number-recall' ? '🔢'
        : l.game === 'sequence-memory' ? '⚡' : '🎨';
      const name = l.game === 'number-recall' ? 'Number Recall'
        : l.game === 'sequence-memory' ? 'Sequence Memory' : 'Colour Recall';
      return `<div class="dc-side-row ${done ? 'done' : ''}">
        <span class="ico">${done ? '✅' : icon}</span>
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
