/**
 * MemoryDuel · 分品类段位（P1-9）客户端契约的类型声明（单一真相源）
 * ────────────────────────────────────────────────────────────────
 * 实际实现见 public/js/category-tiers.mjs —— 它同时被两类页面消费：
 *   ① 打包页面（src/pages/battle.ts、knowledge-lobby.ts）→ 经 window.CategoryTiers
 *   ② 遗留页面（public/train.html 内联脚本）→ 同一个 window.CategoryTiers
 *
 * 🔴 为什么实现放 public/ 而不是 src/shared/*.ts：
 *   train.html 是 public/ 里的遗留页，由 Vite 原样拷进 dist，**不参与打包**，
 *   它只能 `<script type="module" src="/js/category-tiers.mjs">` 引 URL。
 *   如果再在 src/ 里放一份 TS 实现，段位门槛就会有两份、必然漂移
 *   （改一处忘一处 → 大厅显示黄金、对战页记白银）。宁可让打包页面也走
 *   全局对象，也不要复制一份规则。
 *
 * 🔴 三条红线写在实现文件的头注释里，改之前先读一遍：
 *   纯展示不结算 / 不记题目内容 / 一局只写一次。
 */

export {};

/** 段位门槛：n = 该分类累计答题数，acc = 准确率 */
export interface CatTierStep {
  key: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
  n: number;
  acc: number;
}

/** 升到下一段还缺什么。已到顶（钻石）时为 null。 */
export interface CatTierNext {
  /** 目标段位下标 0..4 */
  idx: number;
  /** 还差几题 */
  need: number;
  /** 准确率还差几个百分点（已满足为 0） */
  accNeed: number;
}

export interface CatTierInfo {
  /** -1 = 未定级；0..4 依次青铜→钻石 */
  idx: number;
  acc: number;
  n: number;
  ok: number;
  next: CatTierNext | null;
}

export interface CatTierBadge {
  idx: number;
  /** 未定级时为空串 */
  key: string;
  /** 未定级时为空串（调用方据此不画徽章） */
  text: string;
  /** 悬停/无障碍长文案 */
  title: string;
}

export interface CategoryTiersApi {
  /** localStorage 键名，形如 'md_cat_tiers_v1' */
  KEY: string;
  /** 12 个合法分类 id；不在表内的 cat 会被 record() 丢弃 */
  CATS: readonly string[];
  TIERS: readonly CatTierStep[];
  /** { cat: [n, ok] }；坏数据已剔除，返回的 n 恒 > 0 */
  readAll: () => Record<string, [number, number]>;
  /** 一批作答一次性落盘。返回 { changed }，0 表示没有合法分类 */
  record: (pairs: ReadonlyArray<{ cat: string; ok: boolean }>) => { changed: number };
  stat: (cat: string) => { n: number; ok: number; acc: number };
  tierOf: (n: number, ok: number) => CatTierInfo;
  label: (idx: number, lang?: string) => string;
  /** 「再答 N 题 / 准确率再 +P% 到 X」；已到顶返回空串 */
  hint: (n: number, ok: number, lang?: string) => string;
  badge: (cat: string, lang?: string) => CatTierBadge;
  summary: () => { n: number; ok: number; acc: number; ranked: number };
}

declare global {
  interface Window {
    CategoryTiers?: CategoryTiersApi;
  }
}
