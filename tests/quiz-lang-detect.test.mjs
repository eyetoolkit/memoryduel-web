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
const src = fs.readFileSync(path.join(root, 'public/assets/quiz-data.js'), 'utf8');

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
  // Simulate wrap via fetching is hard; instead inspect source contract:
  const srcText = fs.readFileSync(path.join(root, 'public/assets/quiz-data.js'), 'utf8');
  assert.ok(!/o = \{ en: apiQ\.q \}/.test(srcText), 'old wrap that stamps en with any lang must be gone');
  assert.ok(/qn\[LANG\] = apiQ\.q/.test(srcText), 'wrap must write only LANG slot');
  console.log('✓ Case E: wrap no longer poisons qn.en');
}

console.log('All quiz-lang detect tests passed.');
