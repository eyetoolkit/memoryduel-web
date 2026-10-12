/**
 * MemoryDuel · 每日挑战客户端契约的类型声明（单一真相源）
 * ────────────────────────────────────────────────────────────────
 * 🔴 为什么放独立 d.ts 而不是各页面各自 declare global：
 *   多个页面都 declare 同一个 window 属性时，TS 要求类型**完全一致**，
 *   否则报 TS2717。集中到这里，两个页面 import 同一份定义，
 *   契约改一处两边同步，不会出现「大厅页类型过窄、游戏页类型过宽」。
 *
 * 实际实现见 public/shared/daily-client.js（运行时由普通 script 加载）。
 */

export {};

declare global {
  interface Window {
    DailyClient?: {
      /** 端点前缀，与后端 /api/md/daily 对齐 */
      API: string;
      /** 关卡定义，与后端 LEVELS/maxScoreOf 对齐（maxScore = 整关满分） */
      LEVELS: Record<string, {
        rounds: number;
        startLen: number;
        maxLen: number;
        maxScore: number;
        icon: string;
      }>;
      /** 每日三关的固定顺序 */
      GAME_ORDER: string[];
      LOBBY_URL: string;
      /** 第 n 轮（1 起）的满分，与后端 round 长度规则一致 */
      roundMax: (game: string, round: number) => number;
      ensureSession: () => Promise<{ pid: string; token: string }>;
      fetchToday: () => Promise<{
        date: string;
        levels: Array<{ game: string; rounds: number; maxScore: number }>;
        done: Record<string, boolean>;
        score: Record<string, number>;
        streak: number;
      }>;
      fetchPuzzle: (game: string, round: number) => Promise<{
        date: string;
        game: string;
        round: number;
        puzzle: any;
      }>;
      submitAnswer: (game: string, round: number, answer: unknown) => Promise<{
        game: string;
        round: number;
        correct: boolean;
        score: number;
        total: number;
        maxScore: number;
        perfect: boolean;
        levelDone: boolean;
        allDone: boolean;
        streak: number;
      }>;
      fetchStreak: () => Promise<{ date: string; streak: number; done: boolean }>;
      fetchRank: () => Promise<{ date: string; entries: any[]; note?: string }>;
      resolveMode: (raw: string | null) => { game: string; round: number; queue: string[] } | null;
      loadCred: () => { pid: string; token: string } | null;
    };
  }
}
