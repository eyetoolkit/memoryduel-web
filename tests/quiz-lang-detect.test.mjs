/**
 * P0: English UI must not load Chinese questions because navigator is zh-CN.
 * Exercises detectQuizLang priority by loading quiz-data.js under a mock window.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public/assets/quiz-data.v9.js'), 'utf8');

function loadQuiz(env) {
  const listeners = {};
  const windowObj = {
    API_BASE: '',
    location: {
      search: env.search || '',
      pathname: env.pathname || '/',
      href: 'https://memoryduel.com/' + (env.pathname || '') + (env.search || ''),
    },
    localStorage: {
      _d: Object.assign({}, env.storage || {}),
      getItem(k) { return this._d[k] ?? null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    },
    navigator: { language: env.navigatorLang || 'zh-CN' },
    addEventListener(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    dispatchEvent() { return true; },
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    i18n: env.i18nLang != null ? { getLang: () => env.i18nLang } : undefined,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: { questions: [] } }) }),
  };
  const documentObj = {
    documentElement: {
      lang: env.htmlLang || '',
      getAttribute(name) {
        if (name === 'data-site') return 'memory';
        if (name === 'lang') return this.lang;
        return null;
      },
      setAttribute() {},
    },
  };
  const sandbox = {
    window: windowObj,
    document: documentObj,
    navigator: windowObj.navigator,
    location: windowObj.location,
    localStorage: windowObj.localStorage,
    fetch: windowObj.fetch,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Object,
    Array,
    String,
    Number,
    Math,
    JSON,
    URLSearchParams,
    Blob: class Blob {},
    CustomEvent: windowObj.CustomEvent,
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'quiz-data.js' });
  return sandbox.window.MemoryDuelQuiz;
}

// Case A: zh-CN browser, English UI via localStorage, no ?lang → must be en (NOT navigator zh)
{
  const Q = loadQuiz({
    navigatorLang: 'zh-CN',
    htmlLang: 'en',
    storage: { memoryduel_lang: 'en', lang: 'en' },
  });
  assert.equal(Q.getLang(), 'en', 'storage en must beat navigator zh-CN');
  console.log('✓ Case A: localStorage en beats navigator zh-CN');
}

// Case A2: stored zh must beat static <html lang=en> markup (i18n not ready yet)
{
  const Q = loadQuiz({
    navigatorLang: 'en-US',
    htmlLang: 'en',
    storage: { memoryduel_lang: 'zh' },
  });
  assert.equal(Q.getLang(), 'zh', 'stored zh must beat static html lang=en');
  console.log('✓ Case A2: localStorage zh beats static html lang=en');
}

// Case B: ?lang=en with zh-CN navigator → en
{
  const Q = loadQuiz({
    navigatorLang: 'zh-CN',
    search: '?mode=ai&cat=science&lang=en',
    htmlLang: '',
  });
  assert.equal(Q.getLang(), 'en', '?lang=en must win over navigator');
  console.log('✓ Case B: ?lang=en wins over navigator zh-CN');
}

// Case C: ?lang=zh wins
{
  const Q = loadQuiz({
    navigatorLang: 'en-US',
    search: '?lang=zh',
  });
  assert.equal(Q.getLang(), 'zh', '?lang=zh must be honored');
  console.log('✓ Case C: ?lang=zh honored');
}

// Case D: no hints → default en (not navigator)
{
  const Q = loadQuiz({
    navigatorLang: 'zh-CN',
    htmlLang: '',
    storage: {},
  });
  assert.equal(Q.getLang(), 'en', 'default must be en, not navigator zh');
  console.log('✓ Case D: default en ignores navigator zh-CN');
}

// Case E: wrap must not poison en slot with non-en text
{
  const Q = loadQuiz({ search: '?lang=zh', navigatorLang: 'en-US' });
  assert.equal(Q.getLang(), 'zh');
  // 修订（2026-10-13）：原断言写死 qn[LANG] = apiQ.q，但 wrap 后来加了显式 rawLang 入参
  // （commit 4c74e92「wrap 用 fetchLang 避免模块级 LANG 竞态」），
  // 现在是 qn[L]，L = rawLang || LANG。真正的契约是「只写一个语言槽位，绝不写死 en」：
  //   ① 必须仍以 qn[...]=apiQ.q 形式写入
  //   ② 绝不能再出现把任意语言塞进 en 的旧写法
  const srcText = fs.readFileSync(path.join(root, 'public/assets/quiz-data.v9.js'), 'utf8');
  assert.ok(!/o = \{ en: apiQ\.q \}/.test(srcText), 'old wrap that stamps en with any lang must be gone');
  assert.ok(
    /qn\[\w+\] = apiQ\.q/.test(srcText),
    'wrap 必须只写实际拉取的语言槽位（qn[L] = apiQ.q，L 来自 rawLang || LANG）',
  );
  // op/ex 两个槽位同样只能按 L 写，不得按 en 写
  assert.ok(/op\[\w+\] = apiQ\.options\.slice\(\)/.test(srcText), 'op 槽位同样只写 L');
  assert.ok(/ex\[\w+\] = apiQ\.explain \|\| ''/.test(srcText), 'ex 槽位同样只写 L');
  assert.ok(!/op\.en = apiQ\.options/.test(srcText), '不得把任意语言 options 写进 op.en');
  assert.ok(!/ex\.en = apiQ\.explain/.test(srcText), '不得把任意语言 explain 写进 ex.en');
  console.log('✓ Case E: wrap no longer poisons qn.en');
}

console.log('All quiz-lang detect tests passed.');
