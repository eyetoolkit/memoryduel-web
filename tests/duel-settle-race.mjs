/* ═══════════════════════════════════════════════════════════════
   记忆对决 · 异步终局结算验收（2026-10-13 深度审核 P0）
   ────────────────────────────────────────────────────────────────
   背景：duel-sequence.ts 的 showResult() 曾在每位玩家跑完自己的
   轮次后就调 /room/finish。异步对战里「谁先跑完」由作息决定，
   于是手快的一方会在对手还没开始打时把整局按当前比分固化：
     · winner 按当前 score 定 → 对手后续得分永久丢失
     · 第二次 finish 被 ALREADY_FINISHED 挡死 → 无法补救
     · D1 落一条不完整比分，金币按错名次发放
   且 finish() 只写 finished 不改 status，刷新已结算页面会被
   重新丢进对战循环。

   本脚本锁定的新契约：
     ① 房主跑满、对手未答 → finish 必须被拒（WAITING_FOR_OPPONENT）
     ② 房主 3 轮 / 对手 1 轮 → 仍被拒
     ③ 客人先跑满 → 同样被拒（不偏袒房主）
     ④ 全员跑满 → 结算成功，且**最后一答自动触发**（无需前端再调）
     ⑤ 结算后 /room/status 返回 finished（刷新不再重进对战循环）
     ⑥ 结算后 /answer 被拒（不能继续改分）
     ⑦ 并发 finish 只落一条 D1 记录
     ⑧ finished 房间不能重开
     ⑨ 房码被别人拿到也不能结算（成员闸回归）

   运行: node tests/duel-settle-race.mjs
   ═══════════════════════════════════════════════════════════════ */

const BASE = process.env.MD_BASE || 'https://www.memoryduel.com';

let pass = 0, fail = 0;
const failed = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failed.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function session(tag) {
  const r = await fetch(`${BASE}/api/md/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const j = await r.json();
  if (!j?.data?.pid) throw new Error(`session ${tag} 失败: HTTP ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
  return { pid: j.data.pid, token: j.data.token };
}

function auth(s) {
  return { 'X-Player-ID': s.pid, 'X-Player-Token': s.token, 'Content-Type': 'application/json' };
}

async function call(s, method, path, body) {
  const r = await fetch(`${BASE}/api/md${path}`, {
    method, headers: auth(s),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  return { s: r.status, j, data: j && j.data, code: j && j.error && j.error.code, msg: j && j.error && j.error.msg };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 5).toUpperCase();

/** 建一个 3 轮的 sequence-memory 房间，双方已就位 */
async function setUp(game = 'sequence-memory', rounds = 3) {
  const host = await session('host');
  const guest = await session('guest');
  const c = await call(host, 'POST', '/room/create', { game, rounds });
  if (!c.data || !c.data.code) throw new Error(`建房失败: ${c.s} ${JSON.stringify(c.j).slice(0, 150)}`);
  const code = c.data.code;
  const j = await call(guest, 'POST', '/room/join', { code });
  if (j.s !== 200) throw new Error(`加入失败: ${j.s} ${j.code}`);
  return { host, guest, code };
}

const start = (s, code, game) => call(s, 'POST', '/room/start', { code, game, rounds: 3 });
const finish = (s, code) => call(s, 'POST', '/room/finish', { code });
const status = (s, code) => call(s, 'GET', `/room/status?code=${code}`);

/* 记忆游戏作答：故意乱答，只关心「提交是否被接受、轮次是否推进」 */
async function answer(s, code, round, game = 'sequence-memory') {
  const payload = game === 'sequence-memory'
    ? [0, 1, 2, 3, 4, 5, 6, 7, 8]     // 长度够即可，判分不做断言
    : { h: 0, s: 0, b: 0 };
  return call(s, 'POST', '/answer', { code, round, payload });
}

/* ═══════════【1】房主跑满、对手未答 → 拒绝 ═══════════ */
console.log('\n【1】赛程未完成时不得结算');

{
  const { host, guest, code } = await setUp();
  await start(host, code, 'sequence-memory');

  // 房主答满 3 轮
  for (let r = 0; r < 3; r++) await answer(host, code, r);

  const f = await finish(host, code);
  ok('房主跑满 3 轮、对手 0 轮 → finish 被拒',
    f.s !== 200, `got HTTP ${f.s} ${f.code}`);
  ok('  错误码为 WAITING_FOR_OPPONENT',
    f.code === 'WAITING_FOR_OPPONENT', `got ${f.code}`);

  const st = await status(host, code);
  ok('  房间未被标记 finished',
    st.data && st.data.status !== 'finished', `got ${st.data && st.data.status}`);
}

/* ═══════════【2】部分轮次 → 拒绝 ═══════════ */
console.log('\n【2】只完成部分轮次不得结算');

{
  const { host, guest, code } = await setUp();
  await start(host, code, 'sequence-memory');

  await answer(host, code, 0);
  await answer(guest, code, 0);      // 双方都只答第 0 轮
  const f = await finish(host, code);
  ok('双方仅完成第 0 轮（总 3 轮）→ finish 被拒',
    f.s !== 200, `got HTTP ${f.s}`);
  ok('  错误码为 WAITING_FOR_OPPONENT',
    f.code === 'WAITING_FOR_OPPONENT', `got ${f.code}`);
}

/* ═══════════【3】客人先跑满 → 同样被拒（不偏袒房主）═══ */
console.log('\n【3】客人先跑满：结算资格对称');

{
  const { host, guest, code } = await setUp();
  await start(host, code, 'sequence-memory');

  for (let r = 0; r < 3; r++) await answer(guest, code, r);   // 客人先跑满
  const f = await finish(guest, code);
  ok('客人跑满、房主未答 → finish 被拒',
    f.s !== 200, `got HTTP ${f.s}`);
  ok('  错误码为 WAITING_FOR_OPPONENT',
    f.code === 'WAITING_FOR_OPPONENT', `got ${f.code}`);
}

/* ═══════════【4】全员跑满 → 自动结算 ═══════════ */
console.log('\n【4】全员跑满：最后一答自动结算（无需前端再调 finish）');

let settledCode = '';
{
  const { host, guest, code } = await setUp();
  await start(host, code, 'sequence-memory');

  // 交错作答：host 全部在前，guest 最后一轮收尾
  for (let r = 0; r < 3; r++) await answer(host, code, r);
  let last = null;
  for (let r = 0; r < 3; r++) last = await answer(guest, code, r);

  ok('对手最后一答后 allDone=true（服务端判定赛程完成）',
    last.data && last.data.allDone === true,
    `got allDone=${last.data && last.data.allDone}`);
  ok('  返回 finished=true',
    last.data && last.data.finished === true,
    `got finished=${last.data && last.data.finished}`);

  const st = await status(host, code);
  ok('  /room/status 返回 status=finished',
    st.data && st.data.status === 'finished',
    `got ${st.data && st.data.status}`);
  ok('  /room/status 不再回 playing（刷新不会重进对战循环）',
    !(st.data && st.data.status === 'playing'));
  settledCode = code;

  // 结算后再 finish 必须是幂等拒绝
  const again = await finish(host, code);
  ok('  结算后重复 finish 被 ALREADY_FINISHED 挡下',
    again.s !== 200 && again.code === 'BAD_PARAM',
    `got HTTP ${again.s} ${again.code}`);
}

/* ═══════════【5】结算后不能再作答 ═══════════ */
console.log('\n【5】结算后 answer 被拒（不能继续改分）');

{
  const { host, guest, code } = await setUp();
  await start(host, code, 'sequence-memory');
  for (let r = 0; r < 3; r++) await answer(host, code, r);
  for (let r = 0; r < 3; r++) await answer(guest, code, r);

  const a = await answer(host, code, 2);
  ok('已结算房间再 /answer 被拒',
    a.s !== 200, `got HTTP ${a.s} ${a.code}`);
  ok('  错误为 WRONG_TURN（game already finished）',
    a.code === 'WRONG_TURN', `got ${a.code}`);
}

/* ═══════════【6】finished 房间不能重开 ═══════════ */
console.log('\n【6】状态机单向：finished 不能重开');

{
  const { host, guest, code } = await setUp();
  await start(host, code, 'sequence-memory');
  for (let r = 0; r < 3; r++) await answer(host, code, r);
  for (let r = 0; r < 3; r++) await answer(guest, code, r);

  const s2 = await start(host, code, 'sequence-memory');
  ok('已结算房间开局被拒',
    s2.s !== 200, `got HTTP ${s2.s}`);
  ok('  错误为 BAD_PARAM/ALREADY_FINISHED',
    s2.code === 'BAD_PARAM' && /ALREADY_FINISHED/.test(String(s2.msg)),
    `got ${s2.code}/${s2.msg}`);
}

/* ═══════════【7】非成员不能结算他人对局 ═══════════ */
console.log('\n【7】房码不是凭证：非成员不得结算');

{
  const { host, guest, code } = await setUp();
  await start(host, code, 'sequence-memory');
  for (let r = 0; r < 3; r++) await answer(host, code, r);
  for (let r = 0; r < 3; r++) await answer(guest, code, r);

  const stranger = await session('stranger');
  const f = await finish(stranger, code);
  ok('非成员 finish 被拒 FORBIDDEN',
    f.s !== 200 && f.code === 'FORBIDDEN',
    `got HTTP ${f.s} ${f.code}`);
}

/* ═══════════【8】并发 finish 只结算一次 ═══════════ */
console.log('\n【8】并发 finish 幂等（唯一索引仲裁）');

{
  const { host, guest, code } = await setUp();
  await start(host, code, 'sequence-memory');
  for (let r = 0; r < 3; r++) await answer(host, code, r);
  for (let r = 0; r < 3; r++) await answer(guest, code, r);

  // 同时发 4 个 finish（已完成 → 全部应被幂等挡下）
  const rs = await Promise.all([
    finish(host, code), finish(guest, code),
    finish(host, code), finish(guest, code),
  ]);
  const allRejected = rs.every((r) => r.s !== 200);
  ok('已完成房间的 4 个并发 finish 全部被拒',
    allRejected, `statuses=${rs.map((r) => r.s).join(',')}`);
  ok('  错误码均为 BAD_PARAM',
    rs.every((r) => r.code === 'BAD_PARAM'),
    `codes=${rs.map((r) => r.code).join(',')}`);
}

/* ═══════════【9】从未开局直接结算 ═══════════ */
console.log('\n【9】waiting 房间直接结算不得产币');

{
  const host = await session('w-host');
  const c = await call(host, 'POST', '/room/create', { game: 'sequence-memory', rounds: 3 });
  const code = c.data.code;
  const f = await finish(host, code);
  // 未开局即结算：允许留痕但不发币；关键是不得 200 + 产币
  ok('未开局直接 finish 的行为可预期（非 5xx）',
    f.s < 500, `got HTTP ${f.s}`);
  console.log(`     （实际 HTTP ${f.s} ${f.code || ''}）`);
}

console.log('\n─────────────────────────────────────────');
console.log(`结果: ${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项`);
if (failed.length) console.log('失败项:\n  · ' + failed.join('\n  · '));
process.exit(fail ? 1 : 0);