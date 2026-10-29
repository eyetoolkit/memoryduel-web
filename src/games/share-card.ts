/**
 * MemoryDuel · 分享邀请卡（2026-10-29 起 = 公共引擎薄封装）
 * ─────────────────────────────────────────────────────────────
 * 🔴 2026-10-29 三站统一：Canvas 绘制 + 弹窗交互全部收敛到
 *    fe-shared/shared/invite-card.mjs（与 boardduel 同源，根治
 *    「一站在 A 修 bug、另两站不回流」的漂移）。本文件只剩三件事：
 *      1. 拼链接与二维码端点（/api/md/qr，编码 /games/<game>/lobby/?c=<CODE>）
 *      2. 打开那一刻解析全部文案（Canvas 是像素，缺键烧裸 key 永不修复
 *         —— 判降级 + 英文兜底）
 *      3. tone 映射：memoryduel 对外叫 amber/teal，引擎规范名 wood/forest
 *    导出 API 与旧版完全一致（duel-sequence.ts 等消费方零改动）。
 */

/** 引擎模块（public/shared 静态资源，运行时原生 ESM 加载） */
const ENG_URL = '/shared/invite-card.mjs';

interface InviteCardTexts {
  copy: string; copied: string; copyFailed: string;
  save: string; saved: string; share: string;
  close: string; linkAria: string; qrMain: string; qrSub: string;
}
interface InviteCardConfig {
  title: string; subtitle: string; big?: string; bigLabel?: string;
  stats?: [string, string][];
  url: string; qrSrc: string | null;
  tone: string;
  brand: string; domain: string; scanText: string; ctaText: string; noQrText?: string;
  fileBase: string;
  texts: InviteCardTexts;
}
interface InviteCardModule {
  openInviteCard(cfg: InviteCardConfig): Promise<void>;
  closeInviteCard(): void;
}

let engPromise: Promise<InviteCardModule> | null = null;
function engine(): Promise<InviteCardModule> {
  if (!engPromise) engPromise = import(/* @vite-ignore */ ENG_URL) as Promise<InviteCardModule>;
  return engPromise;
}

export interface ShareData {
  /** 主标题，如「Invite a friend」「Duel finished」 */
  title: string;
  /** 副标题（游戏名 / 结果说明） */
  subtitle: string;
  /** 大字数据，如房码、比分；为空则画装饰 */
  big?: string;
  /** 大字下的小标签 */
  bigLabel?: string;
  /** 三格数据 [标签, 值] */
  stats?: [string, string][];
  /** 卡片内二维码指向的链接 */
  url: string;
  /** worker /api/md/qr 用的 game id；缺省从 url 末段取房码 */
  qrGame?: string;
  /** 主题配色，默认靛蓝（与 MemoryDuel 品牌一致） */
  tone?: 'indigo' | 'amber' | 'teal';
}

/** memoryduel 对外 tone → 引擎规范 tone */
function mapTone(t?: string): string {
  if (t === 'amber') return 'wood';
  if (t === 'teal') return 'forest';
  return t || 'indigo';
}

/**
 * 取一条本地化文案。
 * 返回 === key 就当没查到（字典未就绪/缺键），退回英文兜底 —— 判降级。
 */
function i18nText(key: string, fallback: string): string {
  try {
    const w = window as unknown as {
      t?: (k: string) => string;
      i18n?: { t?: (k: string) => string };
    };
    const fn = w.i18n?.t ?? w.t;
    if (typeof fn === 'function') {
      const v = fn(key);
      if (typeof v === 'string' && v && v !== key) return v;
    }
  } catch { /* 字典未就绪 → 走英文兜底 */ }
  return fallback;
}

/** 房码形态才画二维码；否则 qrSrc=null → Canvas 画 CTA 胶囊、弹窗隐藏二维码行 */
function qrSrcOf(d: ShareData, size: number): string | null {
  const code = d.url.split('/').pop() || '';
  if (!d.qrGame || !/^[A-Z2-9]{4,8}$/i.test(code)) return null;
  return '/api/md/qr?game=' + encodeURIComponent(d.qrGame) +
    '&code=' + encodeURIComponent(code) + '&size=' + size + '&cb=' + Date.now();
}

function textsOf(): InviteCardTexts {
  return {
    copy: i18nText('md.share_copy', 'Copy'),
    copied: i18nText('md.share_copied', 'Link copied'),
    copyFailed: i18nText('md.share_copy_failed', 'Copy failed'),
    save: i18nText('md.share_save', 'Save Image'),
    saved: i18nText('md.share_saved', 'Image saved'),
    share: i18nText('md.share_sys', 'Share'),
    close: i18nText('md.share_close', 'Close'),
    linkAria: i18nText('md.share_link_aria', 'Share link'),
    qrMain: i18nText('md.share_scan_tap', 'Scan or tap the link'),
    qrSub: i18nText('md.share_scan_sub', 'Invite a friend to your duel'),
  };
}

/** 打开卡片（弹窗 + Canvas 绘制全部在公共引擎里） */
export async function openShareCard(d: ShareData): Promise<void> {
  await engine().then((m) => m.openInviteCard({
    title: d.title,
    subtitle: d.subtitle,
    big: d.big,
    bigLabel: d.bigLabel,
    stats: d.stats,
    url: d.url,
    qrSrc: qrSrcOf(d, 220),
    tone: mapTone(d.tone),
    brand: 'MemoryDuel',
    domain: 'memoryduel.com',
    scanText: i18nText('md.share_scan', 'Scan to join the same duel'),
    ctaText: i18nText('md.share_cta', 'Play a free game'),
    noQrText: i18nText('md.share_free', 'Free to play — no sign-up'),
    fileBase: 'memoryduel',
    texts: textsOf(),
  }));
}

export function closeShareCard(): void {
  void engine().then((m) => m.closeInviteCard()).catch(() => { /* noop */ });
}

/* ───────────────────────── 便捷封装（API 不变） ───────────────────────── */

/**
 * 建房场景：把邀请信息渲染成可下载的卡片。
 * @param gameId  worker /api/md/qr 用的 game id（决定 /games/<gameId>/lobby/?c=<CODE> 链接与二维码）
 * @param gameName 卡片上显示的名字，如 'Sequence Memory Duel'（只用于文案，别拿来拼链接）
 */
export function shareInvite(gameId: string, gameName: string, code: string, tone: 'indigo' | 'amber' | 'teal' = 'indigo'): void {
  void openShareCard({
    tone,
    title: i18nText('md.share_invite_title', 'Invite a friend'),
    subtitle: `${gameName} · ${code}`,
    big: code,
    bigLabel: i18nText('md.share_room_code', 'Room code'),
    stats: [
      [i18nText('md.share_stat_game', 'Game'), gameName],
      [i18nText('md.share_stat_status', 'Status'), i18nText('md.share_stat_waiting', 'Waiting')],
      [i18nText('md.share_stat_mode', 'Mode'), i18nText('md.share_stat_1v1', '1 v 1')],
    ],
    url: location.origin + '/games/' + gameId + '/lobby/?c=' + code,
    qrGame: gameId,
  });
}

/** 终局场景：比分 / 结果卡 */
export function shareResult(game: string, opts: {
  youWin: boolean; moves: number; durationSec: number; link: string; tone?: 'indigo' | 'amber' | 'teal'; qrGame?: string;
}): void {
  const m = Math.floor(opts.durationSec / 60);
  const s = Math.round(opts.durationSec % 60);
  void openShareCard({
    tone: opts.tone || (opts.youWin ? 'indigo' : 'teal'),
    title: opts.youWin
      ? i18nText('md.share_result_win', 'Victory')
      : i18nText('md.share_result_good', 'Good game'),
    subtitle: game,
    big: opts.youWin
      ? i18nText('md.share_big_win', 'WIN')
      : i18nText('md.share_big_loss', 'LOSS'),
    bigLabel: opts.youWin
      ? i18nText('md.share_win_sub', 'You held the edge')
      : i18nText('md.share_loss_sub', 'Better luck next time'),
    stats: [
      [i18nText('md.share_stat_moves', 'Rounds'), String(opts.moves)],
      [i18nText('md.share_stat_time', 'Time'), `${m}:${String(s).padStart(2, '0')}`],
      [i18nText('md.share_stat_site', 'Site'), 'MemoryDuel'],
    ],
    url: opts.link,
    qrGame: opts.qrGame,
  });
}
