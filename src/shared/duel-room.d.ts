/**
 * MemoryDuel · 对战房间客户端的类型声明（P1-2 · 2026-10-12）
 * ────────────────────────────────────────────────────────────────
 * 🔴 与 daily-client.d.ts 同理：集中声明，避免多个对战页各自
 *   declare global 同一属性时类型不一致报 TS2717。
 *
 * 实现见 public/shared/duel-room.js（普通 script 加载，不入 bundle）。
 */

export {};

declare global {
  interface Window {
    DuelRoom?: {
      API: string;
      GAMES: Record<string, { icon: string; rounds: number; grid: number }>;
      validCode: (c: string) => boolean;
      normalizeCode: (raw: string) => string;
      loadCred: () => { pid: string; token: string } | null;
      ensureSession: () => Promise<{ pid: string; token: string }>;
      createRoom: (game: string, opts?: { mode?: string; rounds?: number; name?: string })
        => Promise<{ code: string; game: string; mode: string; players: any[] }>;
      joinRoom: (code: string, opts?: { name?: string })
        => Promise<{ code: string; mode: string; players: any[]; maxPlayers: number; rounds: number }>;
      startRoom: (code: string, opts?: { game?: string; rounds?: number; category?: string; lang?: string })
        => Promise<{ started: boolean; game: string; round: number; totalRounds: number }>;
      roomStatus: (code: string) => Promise<{
        code: string; status: string; round: number; totalRounds: number;
        mode: string; game?: string; players?: any[];
      }>;
      /** 逐轮取题。puzzle 是要记的内容（sequence 的 seq / number 的 digits / color 的 colors） */
      fetchRound: (code: string, round: number, game?: string) => Promise<{
        code: string; game: string; round: number; totalRounds: number; puzzle: any;
      }>;
      submitAnswer: (code: string, round: number, payload: unknown,
        extra?: { option?: number; ms?: number }) => Promise<{
        code: string; round: number; game: string;
        correct: boolean; gained: number; score: number; already: boolean; detail?: any;
      }>;
      finishRoom: (code: string) => Promise<any>;
    };
  }
}