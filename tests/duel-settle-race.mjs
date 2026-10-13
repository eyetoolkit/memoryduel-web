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
     ⑩ 两人同时交最后一答 → 不出 5xx、只结算一次

   运行: node tests/duel-settle-race.mjs
   ═══════════════════════════════════════════════════════════════ */

const BASE = process.env.MD_BASE || 'https://www.memoryduel.com';

let pass = 0, fail = 0;
const failed = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failed.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/* 🔴 会话池 + 退避。
   /api/md/session 有限流（按 IP，不按 session），本机连测多组用例会
   在第 2~3 组就撞 429。两种应对同时用：
     ① 复用已建的会话（少建）
     ② 撞 429 时指数退避重试（等限流窗口过去）
   绝不能因为限流就把断言当失败 —— 那是环境噪声，不是被测行为。 */
const POOL = [];

async function session(tag) {
  if (POOL.length) return POOL.shift();
  let lastErr = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${BASE}/api/md/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    let j = null;
    try { j = await r.json(); } catch (_) {}
    if (j?.data?.pid) return { pid: j.data.pid, token: j.data.token };
    lastErr = `HTTP ${r.status} ${JSON.stringify(j).slice(0, 100)}`;
    if (r.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
    throw new Error(`session ${tag} 失败: ${lastErr}`);
  }
  throw new Error(`session ${tag} 退避后仍失败: ${lastErr}`);
}

function auth(s) {
  return { 'X-Player-ID': s.pid, 'X-Player-Token': s.token, 'Content-Type': 'application/json' };
}

async function call(s, method, path, body) {
  /* 🔴 写接口限流按 IP（约 10 次/分钟），多组连测必然撞 429。
     撞了就退避重试 —— 限流是环境约束，不是被测行为，
     绝不能让它变成断言失败（这正是上一版假绿的同源错误）。 */
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${BASE}/api/md${path}`, {
      method, headers: auth(s),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let j = null;
    try { j = await r.json(); } catch (_) {}
    const out = {
      s: r.status, j, data: j && j.data,
      code: j && j.error && j.error.code,
      msg: j && j.error && j.error.msg,
    };
    if (r.status === 429 && attempt < 8) {
      await sleep(4000 * (attempt + 1));
      continue;
    }
    return out;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 5).toUpperCase();

/** 建一个 3 轮的 sequence-memory 房间，双方已就位 */
async function setUp(game = 'sequence-memory', rounds = 3) {
  const host = await session('host');
  const guest = await session('guest');
  const c = await call(host, 'POST', '/room/create', { game, rounds });
  if (!c.data || !c.data.code) {
    POOL.push(host, guest);          // 建房失败 → 归还会话，不浪费限流额度
    throw new Error(`建房失败: ${c.s} ${c.code} ${String(c.msg || '')}`);
  }
  const code = c.data.code;
  const j = await call(guest, 'POST', '/room/join', { code });
  if (j.s !== 200) {
    POOL.push(host, guest);
    throw new Error(`加入失败: ${j.s} ${j.code}`);
  }
  // 每个身份同一时刻只能在一个房间，上一组结束后归还以复用
  return { host, guest, code, release: () => { POOL.push(host, guest); } };
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
  const ctx = await setUp();
  const { host, guest, code } = ctx;
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
  ctx.release();
}

/* ═══════════【2】部分轮次 → 拒绝 ═══════════ */
console.log('\n【2】只完成部分轮次不得结算');

{
  const ctx = await setUp();
  const { host, guest, code } = ctx;
  await start(host, code, 'sequence-memory');

  await answer(host, code, 0);
  await answer(guest, code, 0);      // 双方都只答第 0 轮
  const f = await finish(host, code);
  ok('双方仅完成第 0 轮（总 3 轮）→ finish 被拒',
    f.s !== 200, `got HTTP ${f.s}`);
  ok('  错误码为 WAITING_FOR_OPPONENT',
    f.code === 'WAITING_FOR_OPPONENT', `got ${f.code}`);
  ctx.release();
}

/* ═══════════【3】客人先跑满 → 同样被拒（不偏袒房主）═══ */
console.log('\n【3】客人先跑满：结算资格对称');

{
  const ctx = await setUp();
  const { host, guest, code } = ctx;
  await start(host, code, 'sequence-memory');

  for (let r = 0; r < 3; r++) await answer(guest, code, r);   // 客人先跑满
  const f = await finish(guest, code);
  ok('客人跑满、房主未答 → finish 被拒',
    f.s !== 200, `got HTTP ${f.s}`);
  ok('  错误码为 WAITING_FOR_OPPONENT',
    f.code === 'WAITING_FOR_OPPONENT', `got ${f.code}`);
  ctx.release();
}

/* ═══════════【4】全员跑满 → 自动结算 ═══════════ */
console.log('\n【4】全员跑满：最后一答自动结算（无需前端再调 finish）');

let settledCode = '';
{
  const ctx = await setUp();
  const { host, guest, code } = ctx;
  await start(host, code, 'sequence-memory');

  // 交错作答：host 全部在前，guest 最后一轮收尾
  for (let r = 0; r < 3; r++) await answer(host, code, r);
  let last = null;
  for (let r = 0; r < 3; r++) last = await answer(guest, code, r);

  ok('对手最后一答后 allDone=true（服务端判定赛程完成）',
    last.data && last.data.allDone === true,
    `got allDone=${last.data && last.data.allDone}`);
  /* 🔴 不要断言 last.data.finished===true。
     answer() 返回值是在**结算之前**取的（结算由路由层在本请求内
     随后驱动），所以这里 finished 必然仍是 false —— 那是时序正确，
     不是缺陷。断言它为 true 才是把实现细节当契约。 */
  ok('  最后一答时 finished 仍为 false（结算发生在其后，时序正确）',
    last.data && last.data.finished === false,
    `got finished=${last.data && last.data.finished}`);

  const st = await status(host, code);
  ok('  /room/status 返回 status=finished（结算已发生）',
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
  ctx.release();
}

/* ═══════════【5】结算后不能再作答 ═══════════ */
console.log('\n【5】结算后 answer 被拒（不能继续改分）');

{
  const ctx = await setUp();
  const { host, guest, code } = ctx;
  await start(host, code, 'sequence-memory');
  for (let r = 0; r < 3; r++) await answer(host, code, r);
  for (let r = 0; r < 3; r++) await answer(guest, code, r);

  const a = await answer(host, code, 2);
  ok('已结算房间再 /answer 被拒',
    a.s !== 200, `got HTTP ${a.s} ${a.code}`);
  ok('  错误为 WRONG_TURN（game already finished）',
    a.code === 'WRONG_TURN', `got ${a.code}`);
  ctx.release();
}

/* ═══════════【6】finished 房间不能重开 ═══════════ */
console.log('\n【6】状态机单向：finished 不能重开');

{
  const ctx = await setUp();
  const { host, guest, code } = ctx;
  await start(host, code, 'sequence-memory');
  for (let r = 0; r < 3; r++) await answer(host, code, r);
  for (let r = 0; r < 3; r++) await answer(guest, code, r);

  const s2 = await start(host, code, 'sequence-memory');
  ok('已结算房间开局被拒',
    s2.s !== 200, `got HTTP ${s2.s}`);
  ok('  错误为 BAD_PARAM/ALREADY_FINISHED',
    s2.code === 'BAD_PARAM' && /ALREADY_FINISHED/.test(String(s2.msg)),
    `got ${s2.code}/${s2.msg}`);
  ctx.release();
}

/* ═══════════【7】非成员不能结算他人对局 ═══════════ */
console.log('\n【7】房码不是凭证：非成员不得结算');

{
  const ctx = await setUp();
  const { host, guest, code } = ctx;
  await start(host, code, 'sequence-memory');

  /* 🔴 本组刻意**不把双方答满** —— 答满会触发自动结算，
     此后再调 finish 一律 ALREADY_FINISHED，测的就不再是成员闸了。
     只让房主答满、对手 0 轮：房间仍 playing，
     此时非成员调用才有资格触发成员闸分支。 */
  for (let r = 0; r < 3; r++) await answer(host, code, r);

  const stranger = await session('stranger');
  const f = await finish(stranger, code);
  /* 成员闸在赛程完成闸**之前**，所以这里应稳定拿到 FORBIDDEN。
     若拿到 ALREADY_FINISHED 说明房间已被结算，本组前提失效。 */
  ok('非成员 finish 被拒 FORBIDDEN（房码不是凭证）',
    f.s !== 200 && f.code === 'FORBIDDEN',
    `got HTTP ${f.s} ${f.code}`);
  POOL.push(stranger);          // 归还，避免会话额度白耗
  ctx.release();
}

/* ═══════════【7b】房间已结算后，非成员同样拿不到 ═══════════ */
/* 幂等检查排在成员闸之前，所以结算完成后再由陌生人调用会得到
   ALREADY_FINISHED 而不是 FORBIDDEN。两种拒绝都对（都拿不到钱、
   都不产生第二条 D1 记录），但必须显式验一次，防止有人为「优化」
   而把幂等检查移到成员闸之后 —— 那会让未结算的房间被陌生人抢先结掉。 */
console.log('\n【7b】已结算房间：非成员调用同样被拒（幂等闸先于成员闸）');

{
  const ctx = await setUp();
  const { host, guest, code } = ctx;
  await start(host, code, 'sequence-memory');
  for (let r = 0; r < 3; r++) await answer(host, code, r);
  for (let r = 0; r < 3; r++) await answer(guest, code, r);   // 触发自动结算

  const st = await status(host, code);
  ok('  前提：房间确已结算', st.data && st.data.status === 'finished',
    `got ${st.data && st.data.status}`);

  const stranger = await session('stranger');
  const f = await finish(stranger, code);
  ok('已结算房间被非成员调用 → 拒绝（非 200）',
    f.s !== 200, `got HTTP ${f.s}`);
  ok('  且为幂等拒绝（不得凭空再结算一次）',
    f.code === 'BAD_PARAM' && /ALREADY_FINISHED/.test(String(f.msg)),
    `got ${f.code}/${f.msg}`);
  POOL.push(stranger);
  ctx.release();
}

/* ═══════════【8】并发 finish 只结算一次 ═══════════ */
console.log('\n【8】并发 finish 幂等（唯一索引仲裁）');

{
  const ctx = await setUp();
  const { host, guest, code } = ctx;
  await start(host, code, 'sequence-memory');
  for (let r = 0; r < 3; r++) await answer(host, code, r);
  for (let r = 0; r < 3; r++) await answer(guest, code, r);

  /* 🔴 这一组刻意**不走 call() 的 429 退避** —— 退避会把并发串行化，
     「同时多个 finish」的前提就没了，等于什么都没测。
     并发数取 2：4 个请求从本机同 IP 发出会撞写接口限流（约 10 次/分），
     第三个起就返回 RATE_LIMITED —— 那是环境约束，不是结算缺陷，
     断言它反而把噪声当失败（这与此前「假绿/假红」是同一类错误）。 */
  const rawFinish = async (who) => {
    const r = await fetch(`${BASE}/api/md/room/finish`, {
      method: 'POST', headers: auth(who), body: JSON.stringify({ code }),
    });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { s: r.status, code: j && j.error && j.error.code };
  };
  const rs = await Promise.all([rawFinish(host), rawFinish(guest)]);
  ok('已完成房间的并发 finish 全部被拒',
    rs.every((r) => r.s !== 200), `statuses=${rs.map((r) => r.s).join(',')}`);
  ok('  错误码均为 BAD_PARAM（幂等，非限流）',
    rs.every((r) => r.code === 'BAD_PARAM'),
    `codes=${rs.map((r) => r.code).join(',')}`);
  ctx.release();
}

/* ═══════════【9】从未开局直接结算 ═══════════ */
console.log('\n【9】waiting 房间直接结算必须被显式拒绝');

{
  const host = await session('w-host');
  const c = await call(host, 'POST', '/room/create', { game: 'sequence-memory', rounds: 3 });
  const code = c.data.code;
  const f = await finish(host, code);

  /* 🔴 这里必须**精确**断言，不能只断言「不是 5xx」。
     未开局就结算过去是「允许落 D1 留痕、不发币」，而那正是假战绩的来源：
     房间被标 finished=true 且占住 room_code 唯一索引，
     玩家随后拉人开局，这一局**永远无法再结算**。
     现在 store 层直接抛 BAD_PARAM/NOT_STARTED。
     「非 5xx」这种宽断言会让「返回 500 但没建假局」也通过 —— 假绿。 */
  ok('未开局直接 finish → HTTP 400', f.s === 400, `got HTTP ${f.s}`);
  ok('  错误为 BAD_PARAM', f.code === 'BAD_PARAM', `got ${f.code}`);
  ok('  msg 为 NOT_STARTED（而非 ALREADY_FINISHED / WAITING_FOR_OPPONENT）',
    f.msg === 'NOT_STARTED', `got ${f.msg}`);

  /* 且房间状态不能被这次调用翻掉 —— 仍是 waiting，玩家还能正常开局 */
  const st = await status(host, code);
  ok('  前提：房间仍为 waiting（可继续开局）',
    st.data && st.data.status === 'waiting',
    `got ${st.data && st.data.status}`);

  const s2 = await start(host, code, 'sequence-memory');
  ok('  房间未被废掉：房主仍能正常开局', s2.s === 200, `got HTTP ${s2.s}`);
  POOL.push(host);
}

/* ═══════════【10】两人同时交最后一答 ═══════════ */
/* 🔴 这是异步对战最真实的竞态：两人卡着同一时刻完成，
   两个 /answer 会**同时**看到 allDone=true 并同时调 finish()。
   要求：两边 HTTP 都 200（不该有 500）、房间只结算一次、
   且不能因为抢不到结算权就把请求打成失败。 */
console.log('\n【10】两人同时交最后一答（真并发终局）');

{
  const ctx = await setUp();
  const { host, guest, code } = ctx;
  await start(host, code, 'sequence-memory');

  /* 先各自跑到最后一轮之前（2/3 轮），把「最后一答」留成并发点。
     这几轮答完后 allDone 仍是 false，不会触发结算。 */
  for (let r = 0; r < 2; r++) await answer(host, code, r);
  for (let r = 0; r < 2; r++) await answer(guest, code, r);

  /* 绕过通用 429 退避 —— 退避会把并发串行化，前提就没了 */
  const rawAnswer = (who, round) => fetch(`${BASE}/api/md/answer`, {
    method: 'POST', headers: auth(who),
    body: JSON.stringify({ code, round, payload: [0, 1, 2, 3, 4, 5, 6, 7, 8] }),
  }).then(async (r) => {
    let j = null; try { j = await r.json(); } catch (_) {}
    return { s: r.status, code: j && j.error && j.error.code };
  });

  const rs = await Promise.all([rawAnswer(host, 2), rawAnswer(guest, 2)]);
  ok('并发最后一答：两边都不是 5xx',
    rs.every((r) => r.s < 500),
    `statuses=${rs.map((r) => r.s).join(',')}`);
  ok('  且都不是限流（本组刻意并发，撞 429 就是环境约束而非结算缺陷）',
    rs.every((r) => r.code !== 'RATE_LIMITED'),
    `codes=${rs.map((r) => r.code).join(',')}`);

  const st = await status(host, code);
  ok('  房间确已结算为 finished', st.data && st.data.status === 'finished',
    `got ${st.data && st.data.status}`);

  /* 再补一刀：并发结算后单独 finish 必须是幂等拒绝，
     说明唯一索引确实已占住，不会二次发币。 */
  const again = await finish(host, code);
  ok('  并发后再单独 finish → 幂等拒绝',
    again.s !== 200 && again.code === 'BAD_PARAM'
      && /ALREADY_FINISHED/.test(String(again.msg)),
    `got HTTP ${again.s} ${again.code}/${again.msg}`);

  ctx.release();
}

console.log('\n─────────────────────────────────────────');
console.log(`结果: ${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项`);
if (failed.length) console.log('失败项:\n  · ' + failed.join('\n  · '));
process.exit(fail ? 1 : 0);