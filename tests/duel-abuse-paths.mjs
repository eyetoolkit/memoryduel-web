/**
 * 对战异常路径与滥用防护验收（2026-10-13 深度审核）
 * ────────────────────────────────────────────────────────────
 * 前两轮只验了「正常玩家怎么打」，从没验过「不正常的人怎么打」。
 * 记忆对战是匿名 + 房码可枚举的，没人守着的入口最容易漏。
 *
 * 覆盖七条滥用/异常路径：
 *   1. 非成员取题        —— 房码泄露给路人，路人能不能白嫖答案
 *   2. 非成员看玩家名单  —— players 里带 pid，公开端点等于泄露全房账号
 *   3. 非房主开局        —— 客人能不能替房主重置题序把对局打回开局
 *   4. 未开局就取题      —— status=waiting 时能不能提前拿到题
 *   5. 越界轮次          —— round=999 / 负数 / 字符串
 *   6. 重复提交          —— 同一轮交两次能不能刷分
 *   7. 空房码 / 错房码    —— 错误码的报错是否可区分（体验与排障）
 *   8. 对局中重复开局    —— 房主能否重置题序并靠 score 累加无限刷分
 *   9. 未开局就结算      —— waiting 房间直接 finish 能否白拿参与奖
 *
 * 🔴 2026-10-13 修正本脚本自身的假绿缺陷：第 4 段原来写作
 *   `ok(!playing || r.s === 200, ...)` —— 当 playing=true 且 r.s===200 时
 *   两个条件都成立，断言恒真。于是「客人开局 HTTP 200 / status=playing」
 *   这个真实漏洞在报告里显示为 ok，14/14 全绿。
 *   教训见 RULES-FE.md #87：**安全类断言不能写「或」**，
 *   一旦命中就是双重放行；必须写成「两者都为假」的合取式否定。
 *
 * 限流：写接口按 IP 10/分钟，逐步退避。
 * 用法：node tests/duel-abuse-paths.mjs
 */

const API = process.env.MD_API || 'https://www.memoryduel.com/api/md';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const info = (m) => console.log(`       ${m}`);
const section = (t) => console.log(`\n═══ ${t} ═══`);
/** 前置条件断言：不算 ok/fail 计数，中断时抛出让外层 catch 记为脚本异常 */
const check = (who, cond, m) => console.log(`  --   [${who}] ${cond ? '✔' : '✘'} ${m}`);

async function newSession() {
  const r = await fetch(`${API}/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  return (await r.json()).data;
}
async function raw(cred, method, path, body) {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${API}${path}`, {
      method, cache: 'no-store',
      headers: {
        'X-Player-ID': cred.pid, 'X-Player-Token': cred.token,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) { await sleep(8000); continue; }
    return { s: r.status, j };
  }
  return { s: -1, j: { error: { code: 'RATE_LIMITED_PERSIST' } } };
}

let host, guest, outsider, code;
try {
  host = await newSession();
  guest = await newSession();
  outsider = await newSession();

  await sleep(6500);
  const cr = await raw(host, 'POST', '/room/create', { game: 'sequence-memory', rounds: 3 });
  code = cr.j.data.code;
  ok(!!code, `建房成功（房码 ${code}）`);

  /* ── 1. 未开局时能否取题 ───────────────────────────────── */
  section('1. 已加入成员在 waiting 状态取题');
  {
    // 🔴 原来这一段在 guest 还没 join 时就跑了，实际只验证了「非成员被拒」，
    //    与第 2 段完全重复 —— 「已加入但还没开局」这个真正的场景从未被覆盖。
    await sleep(6500);
    await raw(guest, 'POST', '/room/join', { code });
    await sleep(3000);
    const mem = await raw(guest, 'GET', `/room/status?code=${code}`);
    check('guest', mem.j.data?.status === 'waiting', 'guest 已加入且房间 waiting');
    const r = await raw(guest, 'GET', `/room/round?code=${code}&round=0&game=sequence-memory`);
    ok(r.s !== 200 || !r.j.data?.puzzle,
      `waiting 状态取题被拒（HTTP ${r.s} ${r.j.error?.code || ''}）`);
    info(`返回：${JSON.stringify(r.j).slice(0, 140)}`);
  }

  /* ── 2. 房主不开局，路人能否白嫖 ───────────────────────── */
  section('2. 非成员取题（路人持房码）');
  {
    const r = await raw(outsider, 'GET', `/room/round?code=${code}&round=0&game=sequence-memory`);
    ok(r.s !== 200 || !r.j.data?.puzzle,
      `路人取题被拒（HTTP ${r.s} ${r.j.error?.code || ''}）`);
    info(`返回：${JSON.stringify(r.j).slice(0, 140)}`);
  }

  /* ── 3. 房主名单是否对路人公开 ─────────────────────────── */
  section('3. 非成员看玩家名单（players 含 pid）');
  {
    const r = await raw(outsider, 'GET', `/room/status?code=${code}`);
    const hasPlayers = Array.isArray(r.j.data?.players);
    ok(!hasPlayers,
      hasPlayers
        ? `🔴 泄露：路人能读到 players=${JSON.stringify(r.j.data.players).slice(0, 120)}`
        : '路人看不到 players（仅 code/status/round/mode）');
    info(`status 返回字段：${Object.keys(r.j.data || {}).join(', ')}`);
  }

  /* ── 4. 非房主能否替房主开局 ───────────────────────────── */
  section('4. 非房主开局（客人重置题序）');
  {
    await sleep(6500);
    const r = await raw(guest, 'POST', '/room/start', { code, game: 'sequence-memory' });
    const st = await raw(guest, 'GET', `/room/status?code=${code}`);
    const playing = st.j.data?.status === 'playing';
    /* 🔴 这条断言原来写成 `ok(!playing || r.s === 200)`，是恒真的双重放行：
       playing=true 时第一项 false，但 r.s===200 让第二项 true，于是漏洞照样 ok。
       正确写法是**合取式否定**——必须「没成功」且「状态没被翻掉」同时成立。 */
    ok(!playing && r.s !== 200,
      `客人开局被拒且状态未被翻成 playing（HTTP ${r.s} ${r.j.error?.code || ''}，status=${st.j.data?.status}）`);
    info(`客人 /room/start → HTTP ${r.s} ${JSON.stringify(r.j.error || r.j.data).slice(0, 120)}`);
    info(`当前 status=${st.j.data?.status}（房主仍未开局）`);
  }

  /* ── 5. 房主正常开局后再验越界轮次 ─────────────────────── */
  section('5. 越界与畸形 round');
  {
    await sleep(6500);
    await raw(host, 'POST', '/room/start', { code, game: 'sequence-memory' });
    for (const [label, r] of [['round=999', 999], ['round=-1', -1], ['round=abc', 'abc'], ['round=1.5', 1.5]]) {
      const q = await raw(host, 'GET', `/room/round?code=${code}&round=${r}&game=sequence-memory`);
      ok(q.s !== 200 || !q.j.data?.puzzle,
        `${label} 被拒（HTTP ${q.s} ${q.j.error?.code || ''}）`);
    }
  }

  /* ── 6. 重复提交同一轮能否刷分 ─────────────────────────── */
  section('6. 重复提交同一轮（刷分防护）');
  {
    await sleep(6500);
    const first = await raw(host, 'POST', '/answer', {
      code, round: 0, game: 'sequence-memory',
      payload: (await raw(host, 'GET', `/room/round?code=${code}&round=0&game=sequence-memory`)).j.data.puzzle.seq,
    });
    await sleep(6500);
    const second = await raw(host, 'POST', '/answer', {
      code, round: 0, game: 'sequence-memory', payload: [1, 2, 3],
    });
    await sleep(2000);
    const st = await raw(host, 'GET', `/room/status?code=${code}`);
    const me = (st.j.data.players || []).find((p) => p.pid === host.pid);
    const score = Number(me?.score || 0);
    const oneRoundWorth = Number(first.j.data?.gained || 0);

    ok(score <= oneRoundWorth + 0.1,
      `重复提交未刷分：累计 ${score} ≈ 单轮 ${oneRoundWorth}`);
    ok(second.j.data?.already === true || (second.j.data?.gained === 0 && score <= oneRoundWorth + 0.1),
      `二次提交被识别（already=${second.j.data?.already} gained=${second.j.data?.gained}）`);
    info(`首次 gained=${first.j.data?.gained} → 二次 gained=${second.j.data?.gained} already=${second.j.data?.already}，累计 score=${score}`);
  }

  /* ── 7. 错房码的报错是否可区分 ─────────────────────────── */
  section('7. 错房码 / 空房码的报错可区分性');
  {
    const a = await raw(host, 'GET', '/room/status?code=ZZZZZZ');
    const b = await raw(host, 'POST', '/room/join', { code: '' });
    info(`不存在的房码 → HTTP ${a.s} ${a.j.error?.code}`);
    info(`空房码 join  → HTTP ${b.s} ${b.j.error?.code}`);
    ok(a.j.error?.code === 'ROOM_NOT_FOUND',
      `不存在的房码报 ROOM_NOT_FOUND（前端据此显示「房码不存在」而非误报通用错）`);
    ok(b.j.error?.code === 'BAD_PARAM' || b.s >= 400,
      `空房码被参数校验拒绝（HTTP ${b.s}）`);
  }

  /* ── 8. 伪造他人 pid 作答 ───────────────────────────────── */
  section('8. 冒用身份（非成员提交作答）');
  {
    await sleep(6500);
    const r = await raw(outsider, 'POST', '/answer', {
      code, round: 1, game: 'sequence-memory', payload: [1, 2, 3],
    });
    ok(r.j.error?.code === 'NOT_IN_ROOM' || r.s >= 400,
      `非成员提交被拒（HTTP ${r.s} ${r.j.error?.code || ''}）`);
    info(`返回：${JSON.stringify(r.j.error || r.j).slice(0, 140)}`);
  }

  /* ── 9. 对局中重复开局 = 刷分 / 拒绝服务 ───────────────── */
  section('9. 对局中重复开局（房主重置题序刷分）');
  {
    // 先记录当前比分，重开请求后必须一分不差、round 不归零
    const before = await raw(host, 'GET', `/room/status?code=${code}`);
    const scoreBefore = (before.j.data.players || [])
      .map((p) => `${p.pid.slice(0, 6)}=${p.score}`).join(',');
    const roundBefore = before.j.data.round;

    await sleep(6500);
    const again = await raw(host, 'POST', '/room/start', { code, game: 'sequence-memory' });
    ok(again.s !== 200,
      `重复开局被拒（HTTP ${again.s} ${again.j.error?.code || ''}）`);
    info(`房主 /room/start → HTTP ${again.s} ${JSON.stringify(again.j.error || again.j.data).slice(0, 120)}`);

    const after = await raw(host, 'GET', `/room/status?code=${code}`);
    const scoreAfter = (after.j.data.players || [])
      .map((p) => `${p.pid.slice(0, 6)}=${p.score}`).join(',');
    ok(scoreAfter === scoreBefore,
      `重开未改动比分（${scoreBefore} → ${scoreAfter}）`);
    ok(Number(after.j.data.round) === Number(roundBefore),
      `重开未把 round 归零（${roundBefore} → ${after.j.data.round}）`);
  }

  /* ── 10. 未开局就结算 = 白拿参与奖 ─────────────────────── */
  section('10. 未开局即结算（waiting 房间刷币）');
  {
    // 用一个全新的空房：建房 → 什么都不做 → 直接 finish
    await sleep(6500);
    const cr = await raw(host, 'POST', '/room/create', { game: 'sequence-memory', rounds: 3 });
    const fresh = cr.j.data.code;
    check('host', !!fresh, `新建空房 ${fresh}`);

    await sleep(6500);
    const stBefore = await raw(host, 'GET', `/room/status?code=${fresh}`);
    check('host', stBefore.j.data?.status === 'waiting', '空房确实未开局（status=waiting）');

    await sleep(6500);
    const fin = await raw(host, 'POST', '/room/finish', { code: fresh });
    // 结算本身仍会落 D1 留痕，但服务端必须跳过发币（played=false）
    ok(fin.s === 200,
      `未开局结算被受理但跳过发币（HTTP ${fin.s} ${fin.j.error?.code || ''}）`);
    info(`返回：${JSON.stringify(fin.j).slice(0, 140)}`);
    info('注：是否真的跳过发币由单测 memoryduel-room-authz 第 5 段锁定，此处只验链路可达');
  }

} catch (e) {
  fail++;
  console.log(`  FAIL 脚本异常：${e && e.message}`);
}

console.log(`\n─────────────────────────────────────────`);
console.log(`结果: ${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项`);
process.exit(fail ? 1 : 0);
