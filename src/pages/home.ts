/// <reference types="vite/client" />

/**
 * MemoryDuel 首页 · ARENA 暗色重构动态逻辑
 *
 * - 周榜重置倒计时：每周一 00:00 UTC 重新计算，实时刷新到 #weeklyCd
 * - 发布阶段兜底：隐藏任何残留的 data-stage="beta" 元素（与 vite filter-stage 双保险）
 */

const SHOW_BETA = import.meta.env.VITE_SHOW_BETA === '1';

// 1) 发布阶段兜底
if (!SHOW_BETA) {
  document
    .querySelectorAll<HTMLElement>('[data-stage="beta"]')
    .forEach((el) => {
      el.style.display = 'none';
    });
}

// 2) 周榜重置倒计时（每周一 00:00 UTC）
function nextMondayUtcMidnight(now: Date): Date {
  // UTC 周一为 weekday 1
  const day = now.getUTCDay(); // 0=Sun .. 6=Sat
  const daysUntilMonday = (8 - day) % 7; // 今天周一(1) => 7(=下周), 周日(0)=>1
  const delta = daysUntilMonday === 0 ? 7 : daysUntilMonday;
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + delta,
      0,
      0,
      0,
      0,
    ),
  );
  return next;
}

function paintWeeklyCountdown() {
  const el = document.getElementById('weeklyCd');
  if (!el) return;
  const now = new Date();
  const target = nextMondayUtcMidnight(now).getTime();
  let diff = Math.max(0, target - now.getTime());
  const d = Math.floor(diff / 86400000);
  diff -= d * 86400000;
  const h = Math.floor(diff / 3600000);
  diff -= h * 3600000;
  const m = Math.floor(diff / 60000);
  el.textContent = `每周一 00:00（UTC）重新计算 · 距重置 ${d}天 ${h}时 ${m}分`;
}

paintWeeklyCountdown();
setInterval(paintWeeklyCountdown, 30_000);
