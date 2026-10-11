/* ============================================================
 * MemoryDuel · 白天 / 夜晚主题切换（三档：跟随系统 / 浅 / 深）
 * ------------------------------------------------------------
 * 对标 boardduel src/theme.ts，但自包含为纯 ESM（不进 Vite 构建，
 * 直接以 <script type="module" src="/shared/theme.js"> 引入）。
 *
 * 语义（与 boardduel 完全一致）：
 *   未设置(md-theme2 为空)  → 跟随系统 prefers-color-scheme
 *   'light'                 → 用户显式要浅色（落盘）
 *   'dark'                  → 用户显式要深色（落盘）
 *
 * 触发机制：<html data-theme="dark"> 由本模块在 <html> 上增删；
 *   首页 home.css 与共享层 tokens/components/brand-ds2.css 都挂了
 *   html[data-theme="dark"] 暗色块 → 全站一次性生效。
 *
 * 防 FOUC：各页 <head> 内联早脚本会抢先在 CSS 应用前设好 data-theme，
 *   本模块只负责：切换按钮交互 + 持久化 + 跟随系统实时变更 + 注入按钮。
 *
 * 2026-10-11：初版（memoryduel 深色皮肤专项）。
 * ============================================================ */
(function () {
  "use strict";

  var KEY = "md-theme2";
  var LEGACY_KEY = "md-theme";
  var MIGRATED_KEY = "md-theme-followed";
  var DARK_TC = "#0B1120"; // 与共享暗色 --bg 对齐

  var ICON_MOON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13A8 8 0 1 1 11 4a6.5 6.5 0 0 0 9 9z"/></svg>';
  var ICON_SUN =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2 12h2.4M19.6 12H22M4.2 19.8l1.7-1.7M18.1 5.9l1.7 1.7"/></svg>';

  function getStored() {
    try {
      var t = localStorage.getItem(KEY);
      if (t === "dark" || t === "light") return t;
    } catch (e) {}
    return null;
  }

  function current() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function prefersDark() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (e) {
      return false;
    }
  }

  // 记录页面原始的浅色 theme-color，切回浅色时精确还原（各页 meta 值不同）
  var LIGHT_TC = "#FAF6F1";
  try {
    var m0 = document.querySelector('meta[name="theme-color"]');
    if (m0 && m0.getAttribute("content")) LIGHT_TC = m0.getAttribute("content");
  } catch (e) {}

  function paint(t) {
    var root = document.documentElement;
    if (t === "dark") root.setAttribute("data-theme", "dark");
    else root.removeAttribute("data-theme");

    try {
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", t === "dark" ? DARK_TC : LIGHT_TC);
    } catch (e) {}

    var btns = document.querySelectorAll(".md-theme");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.setAttribute("aria-pressed", String(t === "dark"));
      b.setAttribute("title", t === "dark" ? "Switch to light" : "Switch to dark");
      b.setAttribute("aria-label", t === "dark" ? "Switch to light" : "Switch to dark");
      b.innerHTML = t === "dark" ? ICON_SUN : ICON_MOON;
    }
  }

  function applyTheme(t) {
    paint(t);
    try {
      localStorage.setItem(KEY, t);
    } catch (e) {}
  }

  /* 自动注入切换按钮：
   *   1) 共享头部 .sh-actions 存在 → 追加进去（内容页；#site-header 由 site-header.js 在 DCL 构建）
   *   2) 否则 .nav / nav 存在 → 插到 #lang-switcher 前（首页 .nav 等）
   *   3) 以上都无 → 挂到 body 顶部
   * 已存在 .md-theme 则不重复注入。找不到挂载点会重试（等共享头部构建完）。 */
  var ensureTries = 0;
  function ensureButton() {
    if (document.querySelector(".md-theme")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "md-theme";
    btn.setAttribute("aria-pressed", "false");

    var actions = document.querySelector("#site-header .sh-actions");
    if (actions) {
      actions.appendChild(btn);
      return;
    }
    var nav = document.querySelector(".nav") || document.querySelector("nav");
    if (nav) {
      var ls = nav.querySelector("#lang-switcher");
      if (ls) nav.insertBefore(btn, ls);
      else nav.appendChild(btn);
      return;
    }
    // 挂载点尚未就绪（共享头部异步）：最多重试 ~1.2s
    if (ensureTries++ < 20) {
      setTimeout(ensureButton, 60);
      return;
    }
    document.body.insertBefore(btn, document.body.firstChild);
  }

  function initTheme() {
    // 旧键清理（v1 曾用 md-theme）
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch (e) {}

    var stored = getStored();

    // 一次性迁移：清掉"从未手动选过却被固化成 light"的脏值，
    // 让老用户重新进入「跟随系统」档。只清 light，'dark' 可能是真选的，不动。
    try {
      var migrated = localStorage.getItem(MIGRATED_KEY) === "1";
      if (!migrated) {
        if (stored === "light") localStorage.removeItem(KEY);
        localStorage.setItem(MIGRATED_KEY, "1");
        stored = getStored();
      }
    } catch (e) {}

    ensureButton();

    if (stored) {
      paint(stored); // 显式偏好优先，不跟随系统
    } else {
      paint(prefersDark() ? "dark" : "light"); // 未手动切过 → 跟随系统，且不落盘
      try {
        var mq = window.matchMedia("(prefers-color-scheme: dark)");
        var onChange = function (e) {
          if (getStored()) return; // 期间手动选过 → 交还控制权
          paint(e.matches ? "dark" : "light");
        };
        if (mq.addEventListener) mq.addEventListener("change", onChange);
        else if (mq.addListener) mq.addListener(onChange); // 老 Safari
      } catch (e) {}
    }

    // 委托点击：.md-theme 在重渲染后依然存在，无需重复绑定
    document.addEventListener("click", function (e) {
      var target = e.target;
      var btn = target && target.closest ? target.closest(".md-theme") : null;
      if (!btn) return;
      e.preventDefault();
      applyTheme(current() === "dark" ? "light" : "dark");
    });
  }

  // 必须等 DOMContentLoaded：共享头部 .sh-actions 由 site-header.js 在 DCL 构建，
  // 本模块作为 defer 模块在 readyState=interactive 时执行，早于 DCL，故显式等 DCL，
  // 保证 ensureButton 能找到 .sh-actions（否则回退到 .nav + 重试）。
  if (document.readyState === "complete") {
    initTheme();
  } else {
    document.addEventListener("DOMContentLoaded", initTheme);
  }
})();
