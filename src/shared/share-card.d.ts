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
    /** 右上角徽章。
     *
     * 🔴 2026-10-26：类型须与引擎 `normalizeBadge()` 的实际能力对齐。
     *    引擎接受三种形态并统一归一化：字符串（当纯文字）、{icon,text} 对象、
     *    以及 null / undefined / 空内容（→ 不绘制徽章，不留空药丸）。
     *    此前此处只声明 `badge?: {icon,text}`，导致调用方无法把
     *    `normalizeBadge()` 的 null 结果或字符串形态传进来 —— 类型比实现窄，
     *    tsc 直接报错 TS2322。**声明必须 ≥ 实现的接受范围**，否则引擎加固反而
     *    让调用方编译不过。
     */
    badge?: { icon: string; text: string } | string | null;
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
    /** 🔴 2026-10-26：覆盖引擎内置 meta 字段的标签文案。
     *
     *    引擎内置那套 meta 字段（duration/solutions_count/streak/score/attempts）
     *    是 numeri 的口味，标签原先写死中文（解/连/分/次）与「x分y秒」。
     *    引擎三站共用 + 6 语言，写死中文必然露馅 —— 现在默认是**英文中性兜底**，
     *    需要本地化时由调用方通过本字段传入（键名见引擎 DEFAULT_LABELS）。
     */
    labels?: {
      sec?: string;
      min?: string;
      solved?: string;
      streak?: string;
      score?: string;
      attempts?: string;
    };
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