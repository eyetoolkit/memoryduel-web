/**
 * MemoryDuel · 分享邀请卡（2026-10-29）
 * ─────────────────────────────────────────────────────────────
 * 范式对齐 BoardDuel 的 src/games/share-card.ts：
 *   弹窗里放一张 **Canvas 绘制的大图**（600×760），可下载成 PNG、
 *   可调系统分享；弹窗另带二维码行 + 链接行 + 复制/保存/分享按钮。
 *
 * 与 boardduel 的差异：
 *   · 品牌 MemoryDuel / memoryduel.com，主色靛蓝（与站点统一）
 *   · 邀请链接编码 /games/<game>/lobby/?c=<CODE>（memoryduel 的
 *     duel-sequence.ts 从 ?c= 深链进房，无统一 /room/<code> 落地页）
 *   · 二维码走 worker 的 /api/md/qr（memoryduel 站专属，编码上面的 lobby 链接）
 *
 * Canvas 绘制要点（踩过的坑，抄自 boardduel）：
 *   · 渐变/描边必须等字体就绪后再画
 *   · 圆角矩形用 arcTo 手写（roundRect 在老 Safari 缺失）
 *   · 二维码直接 fetch 成 Image 再 drawImage
 *
 * 数据来源全部是调用方传入的 ShareData —— 本模块不碰游戏状态。
 */
import '../styles/share-card.css';

/** 轻量 toast（自包含，不依赖站点 shared，避免引入额外耦合） */
function toast(msg: string): void {
  try {
    let el = document.querySelector<HTMLDivElement>('.md-share-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'md-share-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    window.clearTimeout((el as unknown as { _t?: number })._t);
    (el as unknown as { _t?: number })._t = window.setTimeout(() => el!.classList.remove('show'), 1800);
  } catch { /* noop */ }
}

/**
 * 取一条本地化文案。
 * ----------------------------------------------------------------
 * Canvas 文字是像素，i18n.js 的 MutationObserver 管不到，必须在绘制时取。
 * 返回 === key 就当没查到（memoryduel 暂未补 md.share_* 六语字典），
 * 退回英文兜底 —— 邀请卡是临时弹窗，英文可接受，补字典即本地化。
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

type Tone = 'indigo' | 'amber' | 'teal';

const THEME: Record<Tone, { bg1: string; bg2: string; glow: string; ring: string; accent: string; label: string; sub: string }> = {
  indigo: { bg1: '#312E81', bg2: '#1E1B4B', glow: 'rgba(99,102,241,.45)', ring: 'rgba(150,150,255,.40)', accent: '#A5B4FC', label: '#E0E7FF', sub: 'rgba(224,231,255,.66)' },
  amber:  { bg1: '#3B2A16', bg2: '#1A1008', glow: 'rgba(245,158,11,.42)', ring: 'rgba(245,180,90,.45)', accent: '#F2B441', label: '#FDE8C8', sub: 'rgba(253,232,200,.66)' },
  teal:   { bg1: '#12301F', bg2: '#07160E', glow: 'rgba(16,185,129,.40)', ring: 'rgba(110,231,183,.42)', accent: '#6EE7B7', label: '#D1FAE5', sub: 'rgba(209,250,229,.66)' },
};

let current: ShareData | null = null;
let root: HTMLDivElement | null = null;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T | null;

/* ───────────────────────── Canvas 绘制 ───────────────────────── */

function roundRect(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, R: number): void {
  x.beginPath();
  x.moveTo(X + R, Y);
  x.arcTo(X + W, Y, X + W, Y + H, R);
  x.arcTo(X + W, Y + H, X, Y + H, R);
  x.arcTo(X, Y + H, X, Y, R);
  x.arcTo(X, Y, X + W, Y, R);
  x.closePath();
}

/** 载入图片为 HTMLImageElement（失败返回 null，不阻塞整卡渲染） */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export async function renderShareCard(canvas: HTMLCanvasElement, d: ShareData): Promise<void> {
  const T = THEME[d.tone || 'indigo'];
  const W = canvas.width;   // 600
  const H = canvas.height;  // 760
  const x = canvas.getContext('2d');
  if (!x) return;

  // 等字体，避免 measureText 拿到 fallback
  try { await (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready; } catch { /* noop */ }

  // 背景：深色渐变 + 径向光晕
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, T.bg1);
  g.addColorStop(1, T.bg2);
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);

  const rg = x.createRadialGradient(W / 2, -40, 40, W / 2, 170, 560);
  rg.addColorStop(0, T.glow);
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = rg;
  x.fillRect(0, 0, W, H);

  // 外框
  x.strokeStyle = T.ring;
  x.lineWidth = 3;
  x.strokeRect(18, 18, W - 36, H - 36);

  x.textAlign = 'center';
  const DISP = '"Space Grotesk", "Sora", system-ui, sans-serif';
  const BODY = '"Sora", system-ui, sans-serif';

  // 顶部 emoji + 标题
  x.fillStyle = T.label;
  x.font = `700 34px ${DISP}`;
  x.fillText(d.title, W / 2, 104);

  // 副标题
  x.fillStyle = T.sub;
  x.font = `500 20px ${BODY}`;
  x.fillText(d.subtitle, W / 2, 140);

  // 大字数据（房码）
  if (d.big) {
    x.fillStyle = T.accent;
    x.font = `800 ${String(d.big).length > 8 ? 64 : 92}px ${DISP}`;
    x.fillText(d.big, W / 2, 288);
  }
  if (d.bigLabel) {
    x.fillStyle = T.label;
    x.font = `600 21px ${BODY}`;
    x.fillText(d.bigLabel, W / 2, 322);
  }

  // 三格数据
  const stats = (d.stats || []).slice(0, 3);
  if (stats.length) {
    const bw = (W - 80) / 3;
    stats.forEach((s, i) => {
      const bx = 40 + i * bw;
      x.fillStyle = 'rgba(255,255,255,.07)';
      roundRect(x, bx, 380, bw - 16, 88, 16);
      x.fill();
      x.fillStyle = T.sub;
      x.font = `600 15px ${BODY}`;
      x.fillText(String(s[0]).slice(0, 18), bx + (bw - 16) / 2, 412);
      x.fillStyle = T.label;
      /* 16 字内用大字；超长（如 "Sequence Memory Duel"）自动缩字 + 截断，
         芯片内宽约 157px，17px 字号 16 字符 ≈ 136px 放得下，不出现 "Sequence Memor" 破相 */
      x.font = `700 ${String(s[1]).length > 12 ? 17 : 28}px ${DISP}`;
      x.fillText(String(s[1]).slice(0, 16), bx + (bw - 16) / 2, 450);
    });
  }

  // 二维码（右下角白底）—— 只有真正带着房号时才画。
  const qrCode = d.url.split('/').pop() || '';
  const hasRoom = !!d.qrGame && /^[A-Z2-9]{6}$/.test(qrCode);

  const panelX = 40, panelW = W - 80, panelY = 530, panelH = 140;

  let qrImg: HTMLImageElement | null = null;
  if (hasRoom) {
    const qrSrc = '/api/md/qr?game=' + encodeURIComponent(d.qrGame as string) +
      '&code=' + encodeURIComponent(qrCode) + '&size=220';
    qrImg = await loadImage(qrSrc);
  }
  const showQr = !!qrImg;

  x.strokeStyle = 'rgba(255,255,255,.12)';
  x.lineWidth = 1;
  x.beginPath();
  x.moveTo(panelX, panelY - 22);
  x.lineTo(W - panelX, panelY - 22);
  x.stroke();

  x.fillStyle = 'rgba(255,255,255,.055)';
  roundRect(x, panelX, panelY, panelW, panelH, 18);
  x.fill();

  x.textAlign = 'left';
  x.textBaseline = 'alphabetic';
  x.fillStyle = T.accent;
  x.font = `800 30px ${DISP}`;
  x.fillText('MemoryDuel', panelX + 28, panelY + 54);
  x.fillStyle = T.sub;
  x.font = `500 17px ${BODY}`;
  x.fillText(showQr
      ? i18nText('md.share_scan', 'Scan to join the same duel')
      : i18nText('md.share_free', 'Free to play — no sign-up'),
    panelX + 28, panelY + 90);

  if (showQr && qrImg) {
    const size = 116, box = size + 14;
    const offX = panelX + panelW - 28 - box;
    const offY = panelY + (panelH - box) / 2;
    x.fillStyle = '#fff';
    roundRect(x, offX, offY, box, box, 10);
    x.fill();
    x.drawImage(qrImg, offX + 7, offY + 7, size, size);
  } else {
    const cta = i18nText('md.share_cta', 'Play a free game');
    x.font = `700 17px ${DISP}`;
    const bw = x.measureText(cta).width + 52, bh = 52;
    const bx = panelX + panelW - 28 - bw, by = panelY + (panelH - bh) / 2;
    x.fillStyle = T.accent;
    roundRect(x, bx, by, bw, bh, 26);
    x.fill();
    x.fillStyle = T.bg2;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(cta, bx + bw / 2, by + bh / 2 + 1);
    x.textAlign = 'left';
    x.textBaseline = 'alphabetic';
  }

  // 底部域名（卡片自带出处，不依赖弹窗的链接框）
  x.fillStyle = T.sub;
  x.font = `500 15px ${BODY}`;
  x.textAlign = 'center';
  x.fillText('memoryduel.com', W / 2, panelY + panelH + 42);
  x.textAlign = 'left';
}

/* ───────────────────────── 弹窗 ───────────────────────── */

export function openShareCard(d: ShareData): void {
  current = d;
  if (!root) root = mount();

  const canvas = $<HTMLCanvasElement>('.md-share-canvas');
  const urlInput = $<HTMLInputElement>('.md-share-url');
  const titleEl = $('.md-share-title');
  const qrImg = $<HTMLImageElement>('.md-share-qr');

  if (titleEl) titleEl.textContent = d.title;
  if (urlInput) urlInput.value = d.url;
  root.hidden = false;
  root.classList.add('show');
  document.body.classList.add('md-invite-open');

  if (canvas) void renderShareCard(canvas, d);
  if (qrImg) {
    const code = d.url.split('/').pop() || '';
    const g = d.qrGame || 'sequence-memory';
    // 复用 worker 的 /api/md/qr（服务端 SVG，免前端 6KB 库）；非房间链接则退回原图
    /* 后端端点未上线 / 加载失败时隐藏破图，只留「点链接」路径——判降级，不烧破图标 */
    qrImg.onerror = () => { qrImg.classList.add('md-qr-broken'); };
    qrImg.onload = () => { qrImg.classList.remove('md-qr-broken'); };
    qrImg.src = code && /^[A-Z2-9]{4,8}$/i.test(code)
      ? '/api/md/qr?game=' + encodeURIComponent(g) + '&code=' + encodeURIComponent(code) + '&size=160&cb=' + Date.now()
      : d.url;
  }
  root.querySelector<HTMLButtonElement>('.md-share-x')?.focus();
}

export function closeShareCard(): void {
  if (!root) return;
  root.classList.remove('show');
  root.hidden = true;
  document.body.classList.remove('md-invite-open');
}

function mount(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'md-share-overlay';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.hidden = true;
  el.innerHTML = `
    <div class="md-share-card">
      <div class="md-share-head">
        <h3 class="md-share-title">${i18nText('md.share_invite_title', 'Invite a friend')}</h3>
        <button type="button" class="md-share-x" data-role="x" aria-label="${i18nText('md.share_close', 'Close')}">✕</button>
      </div>

      <div class="md-share-canvas-wrap"><canvas class="md-share-canvas" width="600" height="760"></canvas></div>

      <div class="md-share-qr-row">
        <img class="md-share-qr" width="76" height="76" alt="${i18nText('md.share_scan', 'Scan to join the same duel')}" decoding="async">
        <div class="md-share-qr-txt"><b>${i18nText('md.share_scan_tap', 'Scan or tap the link')}</b><br>${i18nText('md.share_scan_sub', 'Invite a friend to your duel')}</div>
      </div>

      <div class="md-share-url-row">
        <input class="md-share-url" readonly aria-label="${i18nText('md.share_link_aria', 'Share link')}">
        <button type="button" class="md-btn md-share-sm" data-role="copy">📋 ${i18nText('md.share_copy', 'Copy')}</button>
      </div>

      <div class="md-share-actions">
        <button type="button" class="md-btn md-share-sm" data-role="download">⬇ ${i18nText('md.share_save', 'Save Image')}</button>
        <button type="button" class="md-btn md-share-sm" data-role="system">💬 ${i18nText('md.share_sys', 'Share')}</button>
      </div>
    </div>`;

  document.body.appendChild(el);

  const q = <T extends Element>(role: string) => el.querySelector(`.md-share-card [data-role="${role}"]`) as T;

  el.addEventListener('click', (e) => { if (e.target === el) closeShareCard(); });
  q<HTMLButtonElement>('x').addEventListener('click', closeShareCard);

  q<HTMLButtonElement>('copy').addEventListener('click', async () => {
    const v = $<HTMLInputElement>('.md-share-url')?.value || '';
    if (!v) return;
    try { await navigator.clipboard.writeText(v); toast(i18nText('md.share_copied', 'Link copied')); }
    catch { toast(i18nText('md.share_copy_failed', 'Copy failed')); }
  });

  q<HTMLButtonElement>('download').addEventListener('click', () => {
    const c = $<HTMLCanvasElement>('.md-share-canvas');
    if (!c) return;
    const a = document.createElement('a');
    a.download = `memoryduel-${(current?.big || 'share').replace(/[^\w-]/g, '')}.png`;
    a.href = c.toDataURL('image/png');
    a.click();
    toast(i18nText('md.share_saved', 'Image saved'));
  });

  q<HTMLButtonElement>('system').addEventListener('click', () => {
    const v = $<HTMLInputElement>('.md-share-url')?.value || '';
    const d = current;
    if (navigator.share) {
      void navigator.share({ title: d?.title || 'MemoryDuel', text: d?.subtitle || '', url: v }).catch(() => {});
    } else {
      void navigator.clipboard?.writeText(v).then(
        () => toast(i18nText('md.share_copied', 'Link copied')),
        () => toast(i18nText('md.share_copy_failed', 'Copy failed')));
    }
  });

  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeShareCard(); });
  return el;
}

/* ───────────────────────── 便捷封装 ───────────────────────── */

/**
 * 建房场景：把邀请信息渲染成可下载的卡片，对齐 BoardDuel 的 shareInvite()。
 * @param gameId  worker /api/md/qr 用的 game id（决定 /games/<gameId>/lobby/?c=<CODE> 短链与二维码），如 'sequence-memory'
 * @param gameName 卡片上显示的名字，如 'Sequence Memory Duel'（只用于文案，别拿来拼链接）
 */
export function shareInvite(gameId: string, gameName: string, code: string, tone: Tone = 'indigo'): void {
  openShareCard({
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
  youWin: boolean; moves: number; durationSec: number; link: string; tone?: Tone; qrGame?: string;
}): void {
  const m = Math.floor(opts.durationSec / 60);
  const s = Math.round(opts.durationSec % 60);
  openShareCard({
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
