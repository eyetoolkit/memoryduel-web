/* site-header.nav.js — Memory Duel 本站 Games 导航数据（站点定制文件）
 *
 * 2026-10-22 shared 收敛阶段3：从 site-header.js 内联 GAMES 表外置。
 * 本文件按站不同（boardduel 8 款 / memoryduel 3 项），天然不进
 * 漂移契约（不是共享契约，是站点数据）。
 *
 * 消费方：site-header.js 动态加载后读 window.__SH_NAV__.games。 */
window.__SH_NAV__ = {
  games: [
    { key: "nav.play", label: "Lobby", href: "/#lobby" },
    { key: "nav.train", label: "Solo train", href: "/train.html" },
    { key: "nav.how_to_play", label: "How to play", href: "/how-to-play/memory-match/" }
  ]
};
