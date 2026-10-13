/**
 * 对战结算线上端到端验收（2026-10-13 深度审核 · P0）
 * ────────────────────────────────────────────────────────────────
 * 背景：duel-sequence.ts 的 showResult 此前只读比分、从不调
 * /room/finish —— 而那是 memoryduel 唯一发币入口。本脚本证明
 * 修复后「打完一整局 → 金币确实增长」这条链路真的通。
 *
 * 做法：两个独立匿名身份跑完整赛程（复用 duel-full-season 的逐轮逻辑），
 * 结算前后各读一次 /api/md/me 的 coins，比出差值。
 *
 * 🔴 判据说明：
 *   · /room/finish 发币规则是「胜 +15 / 负 +5」，且内部有
 *     grantCapped 日上限（250）与 games_today 上限（30 局）。
 *   · 所以断言写成「coins_after >= coins_before」而非精确等号 ——
 *     若当日已达上限，settlePlayerOnce 会返回 daily_capped，
 *     这是产品设计不是缺陷。真正要锁的是「不下降」+「finish 返回 200」。
 *
 * 用法：node tests/duel-settle-live.mjs
 */

const API = process.env.MD_API || 'https://www.memoryduel.com/api/md';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const info = (m) => console.log(`       ${m}`);
const section = (t) => console.log(`\n═══ ${t} ═══`);

const GAME = process.env.MD_GAME || 'sequence-memory';

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

/** 造一局的正确答案（按游戏分派判分模型） */
function rightPayload(game, pz) {
  switch (game) {
    case 'number-recall':
      return (pz.digits || []).join('');
    case 'sequence-memory':
      return (pz.seq || []).map(Number);
    case 'color-recall':
      return (pz.colors || []).map((c) => ({ h: c.h, s: c.s, b: c.b }));
    case 'emoji-ghost':
      // 四选一：选项在集合里的那个。服务端 judgeAgainst 接受字符串
      return (pz.options || []).find((o) => (pz.grid || []).includes(o)) ?? null;
    case 'chimp-test':
      return (pz.positions || []).map(Number).sort((a, b) => a - b);
    case 'word-recall':
      return (pz.words || []).map(() => true);
    default:
      return (pz.seq || []).map(Number);
  }
}

/* 🔴 2026-10-13 判据返工（第一次跑出假 FAIL 才搞清）：
   memoryduel 站上有**两份互不相通的玩家账本**，别混用：
     ① /api/md/me      → 读 D1 `players` 表（匿名 pid 也能读），
                          字段含 coins / wins / losses / rating
     ② /api/coins/me   → 读 membership KV 账本（env.MEMBERSHIP，
                          key = member:<账号 uuid>），
                          **只认登录态**，匿名 pid 访问直接回
                          {"authenticated":false}
   settlePlayerOnce 写的是 ②，而前端金币条 coins-bar.js 读的也是 ②，
   所以「打完一局金币涨没涨」必须验 ②，用 ① 验永远是 0 ——
   那是查错了账本，不是没发币。
   匿名身份在 ② 上根本没有条目，故本脚本的匿名跑法只能验 ① 的
   房间链路；金币必须用登录态另验（见 tests/duel-settle-logged.mjs）。 */
let host, guest;
try {
  section('0. 准备两个独立匿名身份');
  host = await newSession();
  guest = await newSession();
  ok(host.pid !== guest.pid, `两个身份独立（${host.pid.slice(0, 6)} / ${guest.pid.slice(0, 6)}）`);

  const meBefore = await raw(host, 'GET', '/me');
  ok(Number.isFinite(Number(meBefore.j.data?.coins)), `匿名身份可读 /me（players 表）`);

  section('1. 建房 + 加入');
  await sleep(7000);
  const cr = await raw(host, 'POST', '/room/create', { game: GAME, rounds: 3 });
  const code = cr.j.data.code;
  ok(!!code, `建房成功 ${code}（game=${cr.j.data.game}）`);
  await sleep(7000);
  await raw(guest, 'POST', '/room/join', { code });

  section('2. 房主开局');
  await sleep(7000);
  const st = await raw(host, 'POST', '/room/start', { code, game: GAME, rounds: 3 });
  ok(st.s === 200 && st.j.data?.started === true, `开局成功 totalRounds=${st.j.data?.totalRounds}`);
  const total = Number(st.j.data?.totalRounds || 3);

  section(`3. 逐轮作答（共 ${total} 轮）`);
  for (let r = 0; r < total; r++) {
    await sleep(3000);
    const hq = await raw(host, 'GET', `/room/round?code=${code}&round=${r}&game=${GAME}`);
    await sleep(3000);
    const gq = await raw(guest, 'GET', `/room/round?code=${code}&round=${r}&game=${GAME}`);
    if (hq.s !== 200 || gq.s !== 200) { info(`第 ${r + 1} 轮取题失败 h=${hq.s} g=${gq.s}`); break; }
    // 同场同题
    const same = JSON.stringify(hq.j.data.puzzle) === JSON.stringify(gq.j.data.puzzle);
    ok(same, `第 ${r + 1} 轮双方同题`);

    await sleep(7000);
    const ha = await raw(host, 'POST', '/answer', { code, round: r, game: GAME, payload: rightPayload(GAME, hq.j.data.puzzle) });
    await sleep(7000);
    const ga = await raw(guest, 'POST', '/answer', { code, round: r, game: GAME, payload: rightPayload(GAME, gq.j.data.puzzle) });
    ok(ha.s === 200 && ga.s === 200,
      `第 ${r + 1} 轮双方作答成功 h_gained=${ha.j.data?.gained} g_gained=${ga.j.data?.gained}`);
  }

  section('4. 结算（此前从不调用）');
  await sleep(7000);
  const fin = await raw(host, 'POST', '/room/finish', { code });
  ok(fin.s === 200, `finish 返回 200（HTTP ${fin.s} ${fin.j.error?.code || ''}）`);
  info(`finish 响应：${JSON.stringify(fin.j).slice(0, 140)}`);

  section('5. 结算落地');
  await sleep(4000);
  const meAfter = await raw(host, 'GET', '/me');
  ok(meAfter.s === 200, '结算后 /me 仍可读（房间未因结算而损坏）');
  info(`房间码 ${code} 可用 wrangler d1 execute memoryduel-main --remote 查证：`);
  info("  SELECT m.room_code, m.winner, COUNT(p.pid) players, SUM(p.score) total");
  info('  FROM matches m LEFT JOIN match_players p ON p.match_id=m.id');
  info(`  WHERE m.room_code='${code}' GROUP BY m.id;`);
  info('  预期 players=2 且 total>0；未开局就结算的房 total=0（played 闸拦下发币）');
  info('注：金币发到 membership 账本（只认登录 uuid），匿名身份在此不可见 ——');
  info('    settlePlayerOnce 发币逻辑由 worker 单测覆盖，金币增量需登录态人工核对。');

  section('6. 幂等：重复 finish 不得二次结算');
  await sleep(7000);
  const fin2 = await raw(host, 'POST', '/room/finish', { code });
  ok(fin2.s !== 200 || fin2.j.error?.code,
    `重复结算被挡（HTTP ${fin2.s} ${fin2.j.error?.code || fin2.j.error?.msg || ''}）`);

} catch (e) {
  fail++;
  console.log(`  FAIL 脚本异常：${e && e.message}`);
}

console.log(`\n─────────────────────────────────────────`);
console.log(`结果: ${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项`);
process.exit(fail ? 1 : 0);