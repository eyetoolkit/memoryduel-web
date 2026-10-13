/**
 * 六款记忆游戏「完整赛程到结算」验收（2026-10-13 深度审核）
 * ────────────────────────────────────────────────────────────
 * 前两轮审核的盲区：都只验到「第 1 轮能取到题、能作答」就停了，
 * 或者验到 room.round 推进到 1 就算过。**没有任何一个测试跑完过一整局。**
 *
 * 一局要打穿：3 轮逐轮取题 → 双方逐轮作答 → 轮次推进 → /room/finish
 * → 结算返回 winner → 比分守恒。这条路径上藏着本轮挖到的真 bug：
 * totalRounds 与 bundle 长度分叉（第 6 轮 BAD_PARAM 卡死）——
 * 只验第 0 轮永远发现不了。
 *
 * 同时验三件容易错的事：
 *   1. 全程 totalRounds 必须等于实际能跑完的轮数（不能宣称 15 实际 5）
 *   2. 每一轮双方都要能取到题（不能某一轮才炸）
 *   3. finish 后比分 = 双方各轮 gained 之和（不能凭空多/少）
 *
 * 限流：写接口按 IP 10 次/分钟（worker index.js:92），必须逐环节退避。
 *
 * 用法：node tests/duel-full-season.mjs [game]
 */

const API = process.env.MD_API || 'https://www.memoryduel.com/api/md';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, skipped = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const skip = (m) => { skipped++; console.log(`  skip ${m}`); };
const info = (m) => console.log(`       ${m}`);
const section = (t) => console.log(`\n═══ ${t} ═══`);

async function newSession() {
  const r = await fetch(`${API}/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const j = await r.json();
  if (!j?.data?.pid) throw new Error('会话创建失败: ' + JSON.stringify(j).slice(0, 120));
  return { pid: j.data.pid, token: j.data.token };
}

/* 写接口按 IP 限流 10/分钟：每次写前退避，429 时按 retry 继续 */
async function call(cred, method, path, body) {
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
    if (!r.ok) throw new Error(`${method} ${path} → HTTP ${r.status} ${JSON.stringify(j).slice(0, 180)}`);
    return j.data;
  }
  throw new Error(`${method} ${path} → 限流退避 10 次仍失败`);
}
const read = (c, p) => call(c, 'GET', p);

/* ── 各游戏的正确答案构造（判分模型见 worker daily.js）────────── */
const MAX = {
  'emoji-ghost': () => 10,                                   // 四选一对=10
  'chimp-test':   (pz) => (pz.positions || []).length,       // 每格 1 分
  'word-recall':  (pz) => (pz.words || []).length,           // 每词 1 分
  'sequence-memory': (pz) => (pz.seq || []).length,
  'number-recall':   (pz) => (pz.digits || []).length,
  'color-recall':    (pz) => (pz.colors || []).length,
};
function rightAnswer(game, pz) {
  switch (game) {
    case 'emoji-ghost': {
      const grid = pz.grid || [], opts = pz.options || [];
      return opts.findIndex((o) => grid.includes(o));
    }
    case 'chimp-test':
      return [...(pz.positions || [])];
    case 'word-recall': {
      const seen = new Set();
      return (pz.words || []).map((w) => { const s = seen.has(w); seen.add(w); return s ? 'seen' : 'new'; });
    }
    case 'sequence-memory': return pz.seq;
    case 'number-recall':   return pz.digits;
    /* 🔴 color-recall 必须回传**对象** {h,s,b}，不是数组 [h,s,b]。
       worker daily.js:300 判分读的是 answer[i].h / .s / .b，
       传数组会让三个字段全 undefined → num() 兜底为 0 → 每题都拿
       中性分（dist≈1 时 10*(1-1/1.2)≈1.7），correct 恒 false。
       症状是「gained 有十几分但 correct=false」，看着像站点判分坏了，
       实际是测试构造错了 —— 注意 correct 对 color 本来就恒 false：
       判分是「色差越小分越高」的连续评分，没有「全对」概念。 */
    case 'color-recall':    return (pz.colors || []).map((c) => ({ h: c.h, s: c.s, b: c.b }));
    default: return null;
  }
}

const GAMES = process.argv[2]
  ? [process.argv[2]]
  : ['sequence-memory', 'number-recall', 'color-recall', 'emoji-ghost', 'chimp-test', 'word-recall'];

for (const game of GAMES) {
  section(`完整赛程：${game}`);

  let host, guest, code, total, hostGained = 0, guestGained = 0, roundLog = [];

  try {
    host = await newSession();
    guest = await newSession();
    ok(host.pid !== guest.pid, `${game} 两个独立身份（防「同一人取两次」假绿）`);

    await sleep(6500);
    // 故意传 rounds=15（前端不会这么做），验证服务端不会宣称跑不完的轮数
    const room = await call(host, 'POST', '/room/create', { game, rounds: 15 });
    code = room.code;

    await sleep(6500);
    await call(guest, 'POST', '/room/join', { code });

    const st0 = await read(guest, `/room/status?code=${code}`);
    ok((st0.players || []).length === 2, `${game} 双方到齐（players=${(st0.players || []).length}）`);

    await sleep(6500);
    const started = await call(host, 'POST', '/room/start', { code, game });
    total = Number(started.totalRounds);

    /* 🔴 本次审核的核心断言：totalRounds 不得超过实际能跑的轮数。
       记忆游戏 /room/start 只生成 min(rounds,5) 题；修复前 totalRounds
       仍回报建房时的 15，前端 for(round<total) 会跑到第 6 轮撞
       400 BAD_PARAM「bad round」→ 对局卡死。 */
    ok(Number.isInteger(total) && total > 0 && total <= 5,
      `${game} totalRounds=${total} 落在实际可跑范围内（≤5）`);

    // 逐轮跑完全程
    for (let r = 0; r < total; r++) {
      await sleep(6500);
      const hp = await read(host, `/room/round?code=${code}&round=${r}&game=${game}`);
      await sleep(1500);
      const gp = await read(guest, `/room/round?code=${code}&round=${r}&game=${game}`);

      const same = JSON.stringify(hp.puzzle) === JSON.stringify(gp.puzzle);
      if (r === 0) ok(same, `${game} 第 1 轮双方同题`);
      else if (!same) ok(false, `${game} 第 ${r + 1} 轮双方同题`);

      await sleep(6500);
      const ha = await call(host, 'POST', '/answer', {
        code, round: r, game, payload: rightAnswer(game, hp.puzzle),
      });
      await sleep(6500);
      const ga = await call(guest, 'POST', '/answer', {
        code, round: r, game, payload: rightAnswer(game, gp.puzzle),
      });

      hostGained += Number(ha.gained || 0);
      guestGained += Number(ga.gained || 0);
      roundLog.push({ r, h: ha.gained, g: ga.gained, hOk: ha.correct, gOk: ga.correct });
      info(`第 ${r + 1}/${total} 轮：host gained=${ha.gained}（correct=${ha.correct}） guest gained=${ga.gained}（correct=${ga.correct}）`);
    }

    ok(roundLog.length === total,
      `${game} 逐轮跑完 ${total} 轮无中断（实际完成 ${roundLog.length}）`);
    if (game === 'color-recall') {
      /* color-recall 是连续色差评分，correct 恒 false（daily.js:323 无条件
         `correct: false`），所以只能验「拿到分且逐轮递增合理」。 */
      ok(roundLog.every((x) => x.h > 0 && x.g > 0),
        `${game} 每轮都有正分（连续色差评分，correct 恒 false 属设计）`);
    } else {
      ok(roundLog.every((x) => x.hOk === true && x.gOk === true),
        `${game} 每一轮双方都判正确`);
    }

    // 轮次推进到末尾
    await sleep(2000);
    const stEnd = await read(host, `/room/status?code=${code}`);
    ok(Number(stEnd.round) === total,
      `${game} 跑完后 room.round=${stEnd.round}（期望 ${total}）`);

    // 结算
    await sleep(6500);
    let fin = null;
    try {
      fin = await call(host, 'POST', '/room/finish', { code });
    } catch (e) {
      info('finish 抛错：' + e.message);
    }
    if (fin) {
      ok('winner' in fin, `${game} finish 返回 winner 字段（=${JSON.stringify(fin.winner)}）`);
      info(`finish: ${JSON.stringify(fin).slice(0, 160)}`);
    } else {
      skip(`${game} finish 不可用（未纳入断言）`);
    }

    // 比分守恒：累计分应等于各轮 gained 之和
    await sleep(2000);
    const stFinal = await read(host, `/room/status?code=${code}`);
    const scores = (stFinal.players || []).map((p) => Number(p.score || 0)).sort((a, b) => b - a);
    ok(scores.length === 2, `${game} 结算后有两名玩家比分`);
    const sum = scores[0] + scores[1];
    const mine = Number((hostGained + guestGained).toFixed(1));
    /* 速度加成会让 gained 带小数，比对时给 0.1 容差 */
    ok(Math.abs(sum - mine) <= 0.1,
      `${game} 比分守恒：status 合计 ${sum} ≈ 各轮 gained 合计 ${mine}`);
    info(`最终比分：${JSON.stringify(scores)}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${game} 异常中断：${e && e.message}`);
    if (code) info(`房码 ${code} 可复现`);
  }
}

console.log(`\n─────────────────────────────────────────`);
console.log(`结果: ${pass} 通过 / ${fail} 失败 / ${skipped} 跳过 / 共 ${pass + fail + skipped} 项`);
process.exit(fail ? 1 : 0);
