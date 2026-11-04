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

/**
 * 🔴 2026-11-04「真下线」：7 款记忆游戏（daily-challenge / sequence-memory /
 * number-recall / color-recall / emoji-ghost / chimp-test / word-recall）已从
 * rollupOptions.input 移除，生产 dist 不再产出这 14 个页面；旧 URL 由
 * public/_redirects 统一 301 到 /games/knowledge-duel/lobby/。
 *
 * 历史教训仍然成立：**Vite 未注册的 MPA 入口会被静默丢弃，不报错**，
 * 线上表现为落到 404 兜底。所以现在反过来——tests/p1-5-color-duel.test.mjs
 * 守卫「下线页不得注册、且必须有 301 规则」，避免有人误加回来。
 *
 * 源文件与 src/pages/duel-sequence.ts 等实现暂留仓库归档（历史回归测试仍读它们），
 * 但不再进入产物、不再被索引、不再有可玩入口。
 */
export default defineConfig({
  plugins: [filterStage(), stripEnvPlaceholders()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        battle: resolve(here, 'battle.html'),
        // 知识对决大厅：当前唯一主推的落地页（选分类 + 四模式，全部真实可用）。
        // ⚠️ key 即产物名：knowledgeLobby → assets/knowledgeLobby-<hash>.js
        knowledgeLobby: resolve(here, 'games/knowledge-duel/lobby/index.html'),
      },
    },
  },
});
