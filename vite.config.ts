import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 发布阶段过滤（feature flag）
 *
 * 首页的游戏卡片与侧边栏入口带 data-stage="live" | "beta"。
 * 生产构建（VITE_SHOW_BETA 未设置）直接把 beta 元素从 HTML 中移除，
 * 因此线上源码里不会残留未上线游戏的链接，也不需要 JS 参与，SEO 准确。
 * 测试构建（VITE_SHOW_BETA=1）保留全部入口。
 */
function filterStage() {
  return {
    name: 'filter-stage',
    transformIndexHtml: {
      order: 'pre' as const,
      handler(html: string) {
        if (process.env.VITE_SHOW_BETA === '1') return html;
        return html.replace(/<a\b[^>]*\bdata-stage="beta"[^>]*>[\s\S]*?<\/a>\s*/g, '');
      },
    },
  };
}

/** 清理 index.html 里用于构建标记的环境变量占位符 */
function stripEnvPlaceholders() {
  return {
    name: 'strip-env-placeholders',
    transformIndexHtml(html: string) {
      return html.replace(/%VITE_[A-Z0-9_]+%/g, '');
    },
  };
}

export default defineConfig({
  plugins: [filterStage(), stripEnvPlaceholders()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // M3（2026-10-01）：battle.html 为第二个 MPA 入口
        // 教师邀请链接 /?mode=battle&c=XXX 跳转至 /battle/ 时由 home.ts 处理，
        // 此处只负责静态资源产出。
        main: resolve(here, 'index.html'),
        battle: resolve(here, 'battle.html'),

        // 多游戏升级 P0-5（2026-10-12）：每日记忆挑战
        // 🔴 必须注册进 rollupOptions.input，否则构建不产出页面（静默丢弃，无报错）。
        // ⚠️ input 的 key 即产物名：dailyChallenge → assets/dailyChallenge-<hash>.js
        //    验收脚本按 key 搜产物，不是 daily-<hash>.js
        dailyChallenge: resolve(here, 'games/daily-challenge/index.html'),
        dailyChallengeLobby: resolve(here, 'games/daily-challenge/lobby/index.html'),

        // P1-2（2026-10-12）：Sequence Memory 双人对战
        // ⚠️ key 即产物名：sequenceDuel → assets/sequenceDuel-<hash>.js
        sequenceDuel: resolve(here, 'games/sequence-memory/index.html'),

        // P1-3（2026-10-12）：Number Recall 对战。
        // 🔴 两个入口**共用同一个 TS 模块**（按路径推断 game），不是两份实现。
        numberDuel: resolve(here, 'games/number-recall/index.html'),

        // P1-5（2026-10-13）：Colour Recall 对战。第三个共用 duel-sequence.ts 的入口。
        // ⚠️ key 即产物名：colorDuel → assets/colorDuel-<hash>.js
        //    注意：三款对战入口会产出三个各自 hash 的 bundle，内容相同但互不共享 ——
        //    这是 MPA 的固有代价（浏览器按页面缓存），接受它，不要试图合并。
        colorDuel: resolve(here, 'games/color-recall/index.html'),
      },
    },
  },
});
