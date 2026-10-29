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
      /** 关卡定义，与后端 LEVELS/maxScoreOf 对齐（maxScore = 整关满分）
          step = 每轮长度步进（老三关 1 / emoji-ghost 2 / word-recall 4） */
      LEVELS: Record<string, {
        rounds: number;
        startLen: number;
        maxLen: number;
        maxScore: number;
        step: number;
        icon: string;
      }>;
      /** 兜底队列（仅首帧用）；每日轮换队列以服务端 today.queue 为准 */
      GAME_ORDER: string[];
      /** 每日轮换池（word-recall 不在内） */
      ROTATION_POOL: string[];
      LOBBY_URL: string;
      /** 第 n 轮（1 起）的题目长度 */
      roundLen: (game: string, round: number) => number;
      /** 第 n 轮（1 起）的满分，与后端 round 长度规则一致 */
      roundMax: (game: string, round: number) => number;
      ensureSession: () => Promise<{ pid: string; token: string }>;
      fetchToday: () => Promise<{
        date: string;
        /** 🔴 服务端 seeded 的今日关卡队列（3 关），客户端不得自造 */
        queue: string[];
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
      /** word-recall 专用：带 lang 取题（漏传会静默拿到英语词库）
       *  第 4 参 opts.practice=1 时服务端放宽 round 上界（练习/难度档要用第 4、5 轮） */
      fetchPuzzleInLang: (game: string, round: number, lang: string, opts?: { practice?: number | boolean }) => Promise<{
        date: string;
        game: string;
        round: number;
        puzzle: any;
      }>;
      /** 当前界面语言（六语兜底 en） */
      fetchAnswerLang: () => string;
      /** 🔴 lang 仅 word-recall 需要，必须与取题时传同一个 */
      submitAnswer: (game: string, round: number, answer: unknown, lang?: string) => Promise<{
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
      /** daily: true 表示该 mode 的队列应由服务端 today.queue 决定 */
      resolveMode: (raw: string | null) => { game: string; round: number; queue: string[]; daily?: boolean } | null;
      loadCred: () => { pid: string; token: string } | null;
    };
  }
}
