# MemoryDuel 分支与发布规范

> 与 `mathduel-web`、`boardduel-web` 完全一致的架构，便于三站统一管理。

## 一、架构总览

| 层 | 说明 |
|---|---|
| `index.html` | Vite 入口首页，含 `data-stage` 发布阶段标记与 `data-build` 构建标记 |
| `public/` | 原样拷贝的静态资源（多语言、SEO 页面、service-worker、manifest、游戏页 `train.html` 等） |
| `src/pages/home.ts` | 发布阶段兜底（构建已剔除 beta 元素，此文件仅在缓存兜底时隐藏） |
| `src/assets/js/home.mjs` ← 注 | 首页交互逻辑，位于 `public/assets/js/`，以 `<script type="module" src>` 直接引用，不参与打包 |
| `legacy/` | 尚未用新架构重写的旧游戏页面，**仅测试环境发布** |
| `scripts/` | `copy-legacy.mjs`（beta 构建复制 legacy）、`filter-sitemap.mjs`（按 `data-stage` 过滤死链） |

> 注：首页交互脚本 `home.mjs` 通过 `src=` 直接引用 `public/` 下的静态模块并自调用 `initHome()`。
> 不要把它改成内联 `import`，否则 Vite 会尝试打包 public 资源而构建失败。

## 二、分支模型（trunk-based）

```
main         生产（memoryduel.com / www.memoryduel.com）
  ▲
beta         测试（beta.memoryduel.com）
  ▲
game/<slug>  单游戏功能分支
```

| 分支 | 对应 Pages 项目 | 环境变量 | 发布内容 |
|---|---|---|---|
| `main` | `memoryduel-web` | 无（`VITE_SHOW_BETA` 未设） | 仅 `data-stage="live"` 的游戏 |
| `beta` | `memoryduel-beta` | `VITE_SHOW_BETA=1` | 全部游戏（含 `legacy/`） |
| `game/<slug>` | 预览部署 | 无 | 单游戏 PR 预览 |

## 三、发布阶段开关（feature flag）

首页游戏入口带 `data-stage="live" | "beta"`：

- **生产构建**（`VITE_SHOW_BETA` 未设置）：`vite.config.ts` 的 `filter-stage` 插件
  在构建时直接把 `data-stage="beta"` 的 `<a>` 元素从 HTML 删除，源码与线上均无残留链接，SEO 准确。
- **测试构建**（`VITE_SHOW_BETA=1`）：保留全部入口，便于内部验收。
- `src/pages/home.ts` 仅在边缘情况兜底（用户/CDN 缓存了旧版 HTML 时隐藏 beta 元素）。

## 四、标准流程

### 上线一款新游戏

1. 在 `game/<slug>` 分支开发，放入 `public/games/<slug>/`（自包含静态页）。
2. 合并到 `beta` 并推送 → 在 `beta.memoryduel.com` 验收。
3. 验收通过后：**先 `git merge beta` 拿到代码，再把首页入口标 `data-stage="live"`，最后推 `main`**。
   - 顺序不能反：先合代码再改标记，否则主站只有开关没有页面。
4. 同步 `beta`：`git checkout beta && git merge main && git push`。

### 新增一款「测试期」游戏（暂不主站上线）

1. 放入 `legacy/games/<slug>/`，首页入口标 `data-stage="beta"`。
2. 仅 `beta` 构建会复制 `legacy/` 到产物，主站不会出现。

## 五、构建与产物

```bash
pnpm install --frozen-lockfile
pnpm build          # 生产：VITE_SHOW_BETA 未设，剔除 beta 元素，过滤 sitemap
pnpm build:beta     # 测试：VITE_SHOW_BETA=1，保留全部，复制 legacy
```

产物在 `dist/`，由 Cloudflare Pages 以 `destination_dir: dist` 托管。
`train.html` 经 Cloudflare Pages 扩展名隐式处理，对外规范地址为 `/train`（sitemap 使用）。

## 六、验证方法（上线后自查）

```bash
# 构建态标记：主站应为空，测试站应为 1
curl -s https://memoryduel.com/        | grep -oE 'data-build="[^"]*"'
curl -s https://beta.memoryduel.com/   | grep -oE 'data-build="[^"]*"'

# 首页游戏入口
curl -s https://memoryduel.com/      | grep -oE 'href="/train.html"[^>]*'
curl -s https://beta.memoryduel.com/ | grep -oE 'href="/train.html"[^>]*'
```

## 七、注意事项

- **环境变量改动需重新部署**：改了 `VITE_SHOW_BETA` 等 Pages 环境变量后，必须触发一次部署才生效（可推一个空提交）。
- **生产 SPA 回退**：未上线的游戏路径（如 `/games/x/`）在主站应返回 404，这是预期行为，不是故障。
- **Pages 项目必须创建时带 source**：重建项目要一步带 `source.github`，之后再 PATCH 构建与环境变量；先建再改 source 类型会失败。
- **自定义域名 DNS 需手动建 CNAME**：绑定 `beta.memoryduel.com` 后，Cloudflare 不会自动写入 DNS，要用 Global API Key（`CF_EMAIL`+`CF_API_KEY`）补一条 CNAME 指向 `<项目>.pages.dev`，证书随后自动签发（约 3–5 分钟）。
- **`home.mjs` 不要改内联 import**：见第一节注。
