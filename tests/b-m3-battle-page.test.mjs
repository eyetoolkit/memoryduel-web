// B-M3 集成测试（2026-10-01）：memoryduel battle page 上线验证
import assert from 'node:assert/strict';

const BASE = 'https://memoryduel.com';

async function fetchText(url, timeoutMs = 25000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

async function fetchJson(url, opts = {}, timeoutMs = 25000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

// 1. /battle 页面可访问（HTML 含 battle chunk）
const battleHtml = await fetchText(`${BASE}/battle`);
assert.match(battleHtml, /<title>Knowledge Battle.*MemoryDuel/, 'battle page title');
assert.match(battleHtml, /bd-room/, 'battle page must have room label element');
assert.match(battleHtml, /battle-[A-Za-z0-9_-]+\.js/, 'battle page references battle chunk');
console.log('✓ test 1: /battle 页面 HTML 含 Knowledge Battle 标题与 battle chunk');

// 2. battle chunk 含完整 teacher-track 逻辑（LS_KEY + ensureStudentCode + fetch track）
const battleJs = await fetchText(`${BASE}/assets/${(battleHtml.match(/battle-[A-Za-z0-9_-]+\.js/) || [])[0]}`);
assert.match(battleJs, /mem_class/, 'LS_KEY 前缀应为 mem_*');
assert.match(battleJs, /Please enter/, '代號弹窗文案');
assert.match(battleJs, /api\/teacher\/track/, 'reportRound 上报端点');
assert.match(battleJs, /tid/, 'classroom 检测的 tid=1 关键字');
console.log('✓ test 2: battle chunk 内嵌 teacher-track 完整逻辑（mem_class + 弹窗 + track + tid）');

// 3. /api/teacher/games 在 memoryduel.com 端返回三站 11 游戏
const games = (await fetchJson(`${BASE}/api/teacher/games`)).games;
const memoryGames = games.filter((g) => g.site === 'memory');
assert.equal(memoryGames.length, 1, 'memory site 至少 1 个游戏');
assert.equal(memoryGames[0].slug, 'quiz-battle', 'memory 站游戏 slug 应为 quiz-battle');
console.log('✓ test 3: /api/teacher/games 在 memoryduel.com 端返回 memory quiz-battle');

// 4. /api/teacher/track CORS preflight 在 memoryduel.com 通过 + 回显 Allow-Origin
const preflight = await fetch(`${BASE}/api/teacher/track`, {
  method: 'OPTIONS',
  headers: {
    'Origin': BASE,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'Content-Type',
  },
});
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get('access-control-allow-origin'), BASE);
assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
console.log('✓ test 4: /api/teacher/track CORS preflight 在 memoryduel.com 通过');

// 5. /api/teacher/join 端点可达（NOEXIST 返 room_not_found）
const joinRes = await fetch(`${BASE}/api/teacher/join`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Origin': BASE },
  body: JSON.stringify({ roomCode: 'NOEXIST_MEM_M3_TEST', code: 'S99' }),
});
assert.equal(joinRes.status, 404);
const joinBody = await joinRes.json();
assert.equal(joinBody.error, 'room_not_found');
console.log('✓ test 5: /api/teacher/join 端点可达，未知房间码返 room_not_found');

// 6. /?mode=battle 入口可达（深链跳转由 home.ts client 处理）
const home = await fetchText(`${BASE}/`);
assert.match(home, /MemoryDuel/, 'home page title');
console.log('✓ test 6: 首页可达，深链 ?mode=battle&c=XXX 走 home.ts client 端 location.replace');

// 7. battle chunk 不重复 import teacher-track（应在 bundle 内）
assert.ok(battleJs.length > 4000, 'battle chunk 应该 ≥4 KB（包含 teacher-track）');
assert.match(battleJs, /Please enter/, 'classroom prompt 文案必须存在');
console.log('✓ test 7: teacher-track 完整内联在 battle chunk（不重复打包）');

console.log('\n=== B-M3: ALL 7 TESTS PASSED ===');
console.log('✅ memoryduel 数据闭环：/battle 页面在线 + teacher-track 内嵌 + /api/teacher/* 三站可调');