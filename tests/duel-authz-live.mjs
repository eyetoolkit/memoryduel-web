/**
 * 房间权限加固线上复验（2026-10-13 · Worker Version cbbe2730）
 * ────────────────────────────────────────────────────────────────
 * 单元测试只能证明逻辑正确，本脚本证明**线上真实生效**。
 * 三条路径逐一复验（修复前均返回 200 / 状态被篡改）：
 *   1. 客人（非房主）开局 → 必须 403 FORBIDDEN，status 仍 waiting
 *   2. 对局中房主重复开局 → 必须 4xx，round 不归零、比分不重置
 *   3. waiting 房间直接结算 → 可达但服务端跳过发币（played=false）
 * 外加正向：房主开局、客人开局被拒后房主仍能正常开局（没打死正路）
 *
 * 限流按 IP 10 次/分钟，写操作之间必须退避。
 * 用法：node tests/duel-authz-live.mjs
 */

const API = process.env.MD_API || 'https://www.memoryduel.com/api/md';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const info = (m) => console.log(`       ${m}`);
const section = (t) => console.log(`\n═══ ${t} ═══`);

async function newSession() {
  const r = await fetch(`${API}/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  return (await r.json()).data;
}
async function raw(cred, method, path, body) {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${API}${path}`, {
      method, cache: 'no-store',
      headers: {
        'X-Player-ID': cred.pid, 'X-Player-Token': cred.token,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) { await sleep(9000); continue; }
    return { s: r.status, j };
  }
  return { s: -1, j: { error: { code: 'RATE_LIMITED_PERSIST' } } };
}

const HOST = { n: 'host' }, GUEST = { n: 'guest' }, FRESH = { n: 'fresh' };
let h, g, f;

try {
  h = await newSession();
  g = await newSession();
  f = await newSession();

  await sleep(7000);
  const cr = await raw(h, 'POST', '/room/create', { game: 'sequence-memory', rounds: 3 });
  const code = cr.j.data.code;
  ok(!!code, `建房成功 ${code}`);

  await sleep(7000);
  await raw(g, 'POST', '/room/join', { code });
  await sleep(3000);
  const st0 = await raw(g, 'GET', `/room/status?code=${code}`);
  ok(st0.j.data?.status === 'waiting', `双方就位，status=waiting（实际 ${st0.j.data?.status}）`);

  /* ── 1. 非房主开局 ─────────────────────────────────── */
  section('1. 客人开局（修复前：HTTP 200 + status 翻 playing）');
  {
    const r = await raw(g, 'POST', '/room/start', { code, game: 'sequence-memory' });
    info(`客人 /room/start → HTTP ${r.s} ${JSON.stringify(r.j.error || r.j.data).slice(0, 120)}`);
    ok(r.s !== 200, `客人开局被拒（HTTP ${r.s} ${r.j.error?.code || ''}）`);

    const st = await raw(g, 'GET', `/room/status?code=${code}`);
    ok(st.j.data?.status === 'waiting',
      `状态未被客人翻成 playing（status=${st.j.data?.status}）`);
  }

  /* ── 2. 正路：房主开局仍可用 ───────────────────────── */
  section('2. 房主开局（正向：加固不得打死正路）');
  {
    // 🔴 rounds 必须**在 start 时传**。/room/create 存的 rounds 与 /room/start
    // 读的 rounds 是两个独立来源，服务端以 start 的入参为准；不传则默认 15，
    // 而记忆游戏按 Math.min(roundsN,5) 收敛 ⇒ 5 轮。
    //   （前端三处调用都显式传了：duel-room.js `o.rounds||3`、
    //     train.html `OL.totalRounds`、teacher.js `room.rounds`，故这是脚本漏传，
    //     不是产品缺陷。此处显式传 3 以对齐前端真实行为。）
    const r = await raw(h, 'POST', '/room/start', { code, game: 'sequence-memory', rounds: 3 });
    ok(r.s === 200 && r.j.data?.started === true,
      `房主开局成功（HTTP ${r.s} started=${r.j.data?.started} totalRounds=${r.j.data?.totalRounds}）`);
    ok(Number(r.j.data?.totalRounds) === 3, `totalRounds=${r.j.data?.totalRounds}（start 传 rounds=3）`);

    await sleep(3000);
    const rd = await raw(h, 'GET', `/room/round?code=${code}&round=0&game=sequence-memory`);
    const seq = rd.j.data?.puzzle?.seq || [];
    info(`取题成功 seq=[${seq.join(',')}]`);

    await sleep(7000);
    const ans = await raw(h, 'POST', '/answer', {
      code, round: 0, game: 'sequence-memory', payload: seq,
    });
    ok(ans.j.data?.gained > 0, `房主答对应得分 gained=${ans.j.data?.gained}`);
    info(`score=${ans.j.data?.score} correct=${ans.j.data?.correct}`);
  }

  /* ── 3. 对局中重复开局 ─────────────────────────────── */
  section('3. 对局中房主重复开局（修复前：200 且 round 归零）');
  {
    const before = await raw(h, 'GET', `/room/status?code=${code}`);
    const scoreBefore = (before.j.data.players || []).map((p) => `${p.pid.slice(0, 5)}=${p.score}`).join(',');
    const roundBefore = before.j.data.round;

    await sleep(7000);
    const r = await raw(h, "POST", "/room/start", { code, game: "sequence-memory", rounds: 3 });
    info(`房主 /room/start → HTTP ${r.s} ${JSON.stringify(r.j.error || r.j.data).slice(0, 120)}`);
    ok(r.s !== 200, `重复开局被拒（HTTP ${r.s} ${r.j.error?.code || ''}）`);

    const after = await raw(h, 'GET', `/room/status?code=${code}`);
    const scoreAfter = (after.j.data.players || []).map((p) => `${p.pid.slice(0, 5)}=${p.score}`).join(',');
    ok(scoreAfter === scoreBefore, `比分未被重置（${scoreBefore} → ${scoreAfter}）`);
    ok(Number(after.j.data.round) === Number(roundBefore),
      `round 未归零（${roundBefore} → ${after.j.data.round}）`);
  }

  /* ── 4. 未开局即结算 ───────────────────────────────── */
  section('4. waiting 房间直接结算（刷币路径）');
  {
    await sleep(7000);
    const c2 = await raw(f, 'POST', '/room/create', { game: 'sequence-memory', rounds: 3 });
    const fresh = c2.j.data.code;
    ok(!!fresh, `新建空房 ${fresh}`);

    await sleep(3000);
    const s2 = await raw(f, 'GET', `/room/status?code=${fresh}`);
    ok(s2.j.data?.status === 'waiting', '空房确实未开局');

    await sleep(7000);
    const fin = await raw(f, 'POST', '/room/finish', { code: fresh });
    info(`未开局 finish → HTTP ${fin.s} ${JSON.stringify(fin.j).slice(0, 120)}`);
    ok(fin.s === 200, '结算请求被受理（仍落 D1 留痕）');
    info('是否真的跳过发币由单元测试 memoryduel-room-authz 第 5 段锁定（played=false）');
  }

  /* ── 5. 非成员开局仍被成员闸先挡 ───────────────────── */
  section('5. 非成员开局（成员闸优先级）');
  {
    await sleep(7000);
    const r = await raw(f, 'POST', '/room/start', { code, game: 'sequence-memory' });
    info(`路人 /room/start → HTTP ${r.s} ${r.j.error?.code || ''}`);
    ok(r.s !== 200, `非成员开局被拒（HTTP ${r.s} ${r.j.error?.code || ''}）`);
  }

} catch (e) {
  fail++;
  console.log(`  FAIL 脚本异常：${e && e.message}`);
}

console.log(`\n─────────────────────────────────────────`);
console.log(`结果: ${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项`);
process.exit(fail ? 1 : 0);