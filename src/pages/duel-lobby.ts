/**
 * MemoryDuel · 六款对战游戏共用大厅页（P3 · 2026-10-14）
 * ────────────────────────────────────────────────────────────────
 * 页面模型（严格两层，照 game-mode-lobby-pattern）：
 *   /games/<id>/lobby/index.html   ← 本文件：只做「选择 + 跳转」
 *        │  卡片 href 是唯一真相
 *        ▼
 *   /games/<id>/index.html         ← duel-sequence.ts 读 location.search 入局
 *
 * 🔴 为什么六款共用一个文件、而不是六份：
 *   六款对战游戏本来就共用同一个 duel-sequence.ts（游戏由 URL 路径推断）。
 *   大厅页若每款写一份，模式清单 / i18n 键 / 修一处漏五处必然发生 ——
 *   这正是 daily 侧已经踩过的坑（同一批 i18n 键要同步六份）。
 *
 * 🔴 诚信铁律（本页最重要的一条约束）：
 *   memoryduel 后端**只有 7 个房间端点**（create/join/start/round/answer/
 *   finish/status），**没有匹配队列、没有 AI 引擎、没有 Elo 排位**。
 *   因此本大厅只列**真实可用**的模式，Random Match / Tournament 一律
 *   用 div.ghost 灰态占位 —— 绝不放 <a>，因为 <a> 即使灰态仍可 Tab 跳转，
 *   点了只会得到一个「服务端没有这个能力」的错误页。
 *   详见 game-mode-lobby-pattern「模式清单 · 诚信铁律」。
 *
 * 本页不跑任何游戏逻辑，也不建房：建房由游戏页的 ?mode=create 触发，
 * 这样建房失败时用户看到的仍是游戏页自己的错误态（限流/封顶/网络）。
 */

import type {} from '../shared/duel-room';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] as string));
}

/** i18n 取值：缺 key 时 t() 会回退成 key 原文，必须识别并改用兜底。
    （红线 #85：不能只判断「返回值非空」，那会把 key 原文当成功。） */
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

/* ─── 六款游戏的真实配置（与 duel-sequence.ts 的 ICON 表保持一致）──
   🔴 只放**真实差异**：图标、标题 i18n 键、SEO 描述。
   轮数/展示时长等属于游戏内核参数，不在这里重抄一份 ——
   大厅页显示的轮数必须与实际玩到的轮数一致，写死就会漂移。 */
interface GameMeta {
  id: string;
  icon: string;
  /** i18n 标题键，缺失时用 id 兜底 */
  titleKey: string;
  titleFallback: string;
  /** 侧栏「本局说明」i18n 键 */
  blurbKey: string;
  blurbFallback: string;
}

const GAMES: Record<string, GameMeta> = {
  'sequence-memory': {
    id: 'sequence-memory', icon: '⚡',
    titleKey: 'dl.title_sequence', titleFallback: 'Sequence Memory Duel',
    blurbKey: 'dl.blurb_sequence',
    blurbFallback: 'Tiles light up one by one. Two players get the same order — who remembered it better?',
  },
  'number-recall': {
    id: 'number-recall', icon: '🔢',
    titleKey: 'dl.title_number', titleFallback: 'Number Recall Duel',
    blurbKey: 'dl.blurb_number',
    blurbFallback: 'Digits flash, then vanish. Type them back before your opponent does.',
  },
  'color-recall': {
    id: 'color-recall', icon: '🎨',
    titleKey: 'dl.title_color', titleFallback: 'Colour Recall Duel',
    blurbKey: 'dl.blurb_color',
    blurbFallback: 'Five colours appear, then vanish. Rebuild each one on the colour wheel.',
  },
  'emoji-ghost': {
    id: 'emoji-ghost', icon: '👻',
    titleKey: 'dl.title_emoji', titleFallback: 'Emoji Ghost Duel',
    blurbKey: 'dl.blurb_emoji',
    blurbFallback: 'A row of symbols flashes and one vanishes. Pick which one it was.',
  },
  'chimp-test': {
    id: 'chimp-test', icon: '🐒',
    titleKey: 'dl.title_chimp', titleFallback: 'Chimp Test Duel',
    blurbKey: 'dl.blurb_chimp',
    blurbFallback: 'Numbers flash on a grid, then vanish. Tap every cell that held one.',
  },
  'word-recall': {
    id: 'word-recall', icon: '📝',
    titleKey: 'dl.title_word', titleFallback: 'Word Recall Duel',
    blurbKey: 'dl.blurb_word',
    blurbFallback: 'Words appear one by one. Then mark each as seen or new.',
  },
};

/** 由路径推断游戏 —— 与 duel-sequence.ts 的 inferGame() 同源。
    ⚠️ 必须在**每个游戏自己的路径前**匹配，顺序不能乱：
    /games/xxx/lobby/ 与 /games/xxx/ 用同一条正则即可（都含 /games/xxx/）。 */
function inferGame(): string {
  const p = location.pathname;
  for (const id of Object.keys(GAMES)) {
    if (p.indexOf('/games/' + id + '/') >= 0) return id;
  }
  return 'sequence-memory';
}

const GAME = inferGame();
const META = GAMES[GAME] || GAMES['sequence-memory'];
/** 游戏页地址（深链目标）。大厅页自己不在这个列表里，避免自指。 */
const GAME_URL = '/games/' + GAME + '/';
/** 本页地址（无效 mode 回退目标） */
const LOBBY_URL = '/games/' + GAME + '/lobby/';

/** 大厅页不在游戏页的深链目标里，故此处不校验 mode 是否合法 ——
    合法 mode 由 duel-sequence.ts 判定。这里只负责回退。
    （与 daily-lobby.ts 同理，但 daily 那边的合法值来自 DailyClient.resolveMode，
      对战侧没有契约层，故判定放在游戏页单一真相点。） */
function bounceIfInvalidMode(): void {
  const mode = new URLSearchParams(location.search).get('mode');
  if (mode) location.replace(LOBBY_URL);
}

async function main() {
  // 🔴 无效 mode 深链：回大厅，不留在半死状态（红线 #89 的同类要求）
  bounceIfInvalidMode();

  const g = window as any;

  // 侧栏「如何计分」：只讲规则，不编造自己的战绩。
  // 🔴 诚信铁律：/api/account/me 没有 rating 字段，所以**不显示任何 Elo/排名数字**。
  //   曾经想过「Guest / unrated」这种占位，但同样会被误读成「有评级只是没登录」，
  //   最终只讲计分口径（服务端权威、按耗时给速度加成），这些是真实规则。
  const side = document.getElementById('dlRules');
  if (side) {
    side.innerHTML = [
      `<div class="dc-side-row"><span class="ico">🎯</span><span class="nm">${esc(t('dl.rule_server', 'Server-authoritative scoring'))}</span></div>`,
      `<div class="dc-side-row"><span class="ico">⏱️</span><span class="nm">${esc(t('dl.rule_speed', 'Faster answers earn a speed bonus'))}</span></div>`,
      `<div class="dc-side-row"><span class="ico">🔁</span><span class="nm">${esc(t('dl.rule_async', 'Asynchronous — play any time'))}</span></div>`,
    ].join('');
  }

  // 侧栏「玩法说明」：从 i18n 取，缺键走英文兜底
  const blurbHost = document.getElementById('dlBlurb');
  if (blurbHost) blurbHost.textContent = t(META.blurbKey, META.blurbFallback);

  // 英雄区标题回填（i18n 脚本可能先于本模块完成，也可能后到，故轮询一小会）
  for (let i = 0; i < 12; i++) {
    const h1 = document.getElementById('dlH1');
    if (h1 && !h1.textContent.trim()) {
      const name = t(META.titleKey, META.titleFallback);
      h1.innerHTML = `${esc(name.replace(' Duel', ''))} <em>${esc(t('dl.h1_em', 'Play your way.'))}</em>`;
    }
    await sleep(30);
    if (g.document && document.title && document.title.indexOf('MemoryDuel') >= 0 && i > 2) break;
  }

  // 拉一次玩家自己的进行中房间（有就提示「回到未完成的对局」）
  // 🔴 sessionStorage 的 duel-code 是**真实使用中的键**（duel-sequence.ts main() 读它恢复房间），
  //   不清会让「大厅页按钮永不出现」这类问题跨页互相污染 —— 见用户记忆里的验收纪律第 2 条。
  try {
    const saved = sessionStorage.getItem('duel-code') || '';
    const host = document.getElementById('dlResume');
    if (host && /^[A-Z2-9]{6}$/.test(saved)) {
      host.hidden = false;
      const a = document.getElementById('dlResumeBtn');
      if (a) a.setAttribute('href', GAME_URL + '?c=' + saved);
      const lbl = document.getElementById('dlResumeCode');
      if (lbl) lbl.textContent = saved;
    }
  } catch (_) { /* 隐私模式下 sessionStorage 可能抛错，忽略即可 */ }
}

void main();
