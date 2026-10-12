/**
 * MemoryDuel · 分享卡引擎契约的类型声明（单一真相源）
 * ────────────────────────────────────────────────────────────────
 * 与 daily-client.d.ts 同理：单独一个 d.ts，避免多个页面各自
 * declare global 时因类型不一致触发 TS2717。
 *
 * 实际实现见 public/shared/share-card.js（三站共用，运行时由普通 script 加载）。
 */

export {};

declare global {
  /** 分享卡输入。
   *
   * 🔴 icon / gameName / metaLines 三个字段是 2026-10-13（P1-4）新开的覆盖入口。
   *    引擎内置的游戏表是 numeri 的口味（24点/金字塔/数独），把三站的游戏
   *    都塞进去只会让那张表变成谁都不敢改的共享状态。引擎只管排版，
   *    「显示什么」交给调用方 —— 不填就回落到内置表，存量调用方零改动。
   */
  interface ShareCardInput {
    /** 内置表里的游戏 id（'24-game' | 'pyramid' | 'sudoku'）。新游戏可填任意值。 */
    game?: string;
    /** 覆盖图标（emoji）。优先于内置表。 */
    icon?: string;
    /** 覆盖游戏名。优先于内置表。 */
    gameName?: string;
    /** 主标题，通常是分数。 */
    title: string;
    /** 副标题，通常是「今天 32 / 74」这类补充说明。 */
    subtitle?: string;
    /** 行动号召。 */
    cta?: string;
    /** 卡面底部展示的 URL，默认取站点 host。 */
    url?: string;
    /** 右上角徽章。 */
    badge?: { icon: string; text: string };
    /** numeri 口味的结构化 meta（duration/solutions_count/streak/score/attempts）。 */
    meta?: {
      duration?: number;
      solutions_count?: number;
      streak?: number;
      score?: number;
      attempts?: number;
    };
    /** 🔴 直接给定展示行（最多 4 行），优先于 meta。 */
    metaLines?: string[];
  }

  interface Window {
    ShareCard?: {
      renderCard: (canvas: HTMLCanvasElement, card: ShareCardInput, site?: string) => HTMLCanvasElement;
      downloadCard: (canvas: HTMLCanvasElement, filename?: string, site?: string) => void;
      toDataURL: (canvas: HTMLCanvasElement, type?: string, quality?: number) => string;
      copyToClipboard: (canvas: HTMLCanvasElement) => Promise<boolean>;
      buildCardDataURL: (card: ShareCardInput, site?: string) => string;
      /** 无 Canvas 环境的 SVG 兜底（Node 测试与人眼审图用） */
      toSVG: (card: ShareCardInput, site?: string) => string | null;
      SITES: Record<string, unknown>;
      resolveSite: (site?: string) => string;
      colorsFor: (site?: string) => Record<string, string>;
    };
  }
}