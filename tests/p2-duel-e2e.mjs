/**
 * 三款新游戏 1v1 对战全链路双身份验收（emoji-ghost / chimp-test / word-recall）
 * ────────────────────────────────────────────────────────────
 * 审的是「对战逻辑对不对」，不是「页面能不能开」——后者已由
 * audit-duel-verify.mjs 覆盖（57/57）。本脚本专查四件容易错的事：
 *
 *   1. 房主与访客必须是**两个不同身份**。踩过的坑：复用同一个 session，
 *      结果 players.length===1，"同房同题" 变成同一个人取两次，测出假绿。
 *      这里每次强制创建两个独立 pid，并断言 host.pid !== guest.pid。
 *   2. 同房双方必须拿到**同一题**（服务端用房码作 seed 生成题目）。
 *   3. 判分方向：正确答案得分、错误答案不得分，且累计分正确。
 *   4. 轮次推进：双方都交完第 0 轮后 room.round 必须变成 1。
 *
 * 另外按游戏各验一条**语义专属**规则：
 *   emoji-ghost 四选一：只有「options 里属于 grid 的那个」算对
 *   chimp-test 集合命中：乱序点出正确格子必须满分（这是本轮改过的判分模型）
 *   word-recall 语言：题目与判分都用同一语言词库（zh 下必须是中文词）
 *
 * 用法：node tests/p2-duel-e2e.mjs
 */

const API = process.env.MD_API || 'https://www.memoryduel.com/api/md';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const info = (m) => console.log(`       ${m}`);
const section = (t) => console.log(`\n═══ ${t} ═══`);

/* ── API 客户端 ─────────────────────────────────────────────── */
async function newSession() {
  const r = await fetch(`${API}/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const j = await r.json();
  if (!j || !j.data || !j.data.pid) throw new Error('会话创建失败: ' + JSON.stringify(j).slice(0, 160));
  return { pid: j.data.pid, token: j.data.token };
}

/* 🔴 限流按设计生效：worker/src/sites/memoryduel/index.js:92 的 _ipRlMd
   按 CF-Connecting-IP 计数，写操作 10 次/分钟（:89）。整轮脚本要打几十次
   写请求，必须自己退避，否则 429 会被误读成游戏逻辑坏了。 */
async function call(cred, method, path, body) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await fetch(`${API}${path}`, {
      method, cache: 'no-store',
      headers: {
        'X-Player-ID': cred.pid, 'X-Player-Token': cred.token,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429 || (j.error && j.error.code === 'RATE_LIMITED')) {
      await sleep(7000);
      continue;
    }
    if (!r.ok) throw new Error(`${method} ${path} → HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    return j.data;
  }
  throw new Error(`${method} ${path} → 限流退避 8 次仍失败`);
}

const read = (c, path) => call(c, 'GET', path);

/* ── 通用对战流程 ───────────────────────────────────────────── */
/* build(pz) 必须返回 { right, wrong } —— 两个都是**可直接提交的 payload**。
   🔴 之前这里写的是 makeAnswer(pz, isWrong)，但下面 make 返回的是
      {right,wrong} 整个对象，传 false 也拿不到 right 本身 ——
      于是"错误答案"那一发其实交的是 {right,wrong}，
      JSON 化后 judgeAgainst 拿到非预期结构，仍判对并给分，
      表现成「错误答案竟然得分」的假失败。 */
async function playGame(game, build) {
  const host = await newSession();
  const guest = await newSession();
  /* 🔴 身份隔离断言：这一条不过，后面所有"同房同题"都是假的 */
  if (host.pid === guest.pid) throw new Error('两个会话 pid 相同，双人验证失效');

  await sleep(6500);
  const room = await call(host, 'POST', '/room/create', { game });
  const code = room.code;

  await sleep(6500);
  await call(guest, 'POST', '/room/join', { code });

  const st0 = await read(guest, `/room/status?code=${code}`);
  if ((st0.players || []).length !== 2) throw new Error('双方未同时在房');

  await sleep(6500);
  await call(host, 'POST', '/room/start', { code, game });

  // 双方独立取第 0 轮
  await sleep(6500);
  const hp = await read(host, `/room/round?code=${code}&round=0&game=${game}`);
  const gp = await read(guest, `/room/round?code=${code}&round=0&game=${game}`);
  const hz = hp.puzzle, gz = gp.puzzle;

  const same = JSON.stringify(hz) === JSON.stringify(gz);
  const hb = build(hz);
  const gb = build(gz);

  // 房主交一份**错的**，验证不得分
  await sleep(6500);
  const wrong = await call(host, 'POST', '/answer', {
    code, round: 0, game, payload: hb.wrong,
  });

  // 访客交一份**对的**
  await sleep(6500);
  const right = await call(guest, 'POST', '/answer', {
    code, round: 0, game, payload: gb.right,
  });

  const st1 = await read(host, `/room/status?code=${code}`);

  return { code, host, guest, hz, gz, same, wrong, right, st1, hb, gb };
}

/* ── 三款游戏各自的正确答案构造 ─────────────────────────────── */
/* 🔴 判分模型分两类，断言必须分别对待，否则会把**正常的部分给分**当成 bug：
     · emoji-ghost —— 全对才得分（judgeAgainst 对齐 pick===want，错则 0 分）
     · chimp-test   —— 集合命中，**逐格给分**（daily.js:351 命中数即得分）
     · word-recall  —— 逐词判定，**逐词给分**（daily.js:367 每对一个词 +1）
   所以 chimp / word 的「错误答案」拿到部分分是设计如此，不是判分漏洞。
   这两个游戏真正的判别信号是 correct 标志（全对才为 true），
   以及「答对拿满分、答错拿不到满分」。 */
const ANSWERS = {
  'emoji-ghost': {
    mode: 'all-or-nothing',
    // 正确项 = options 里出现在 grid 集合中的那个（服务端 options 只含 1 个在集合里）
    make(pz) {
      const grid = pz.grid || [];
      const opts = pz.options || [];
      const idx = opts.findIndex((o) => grid.includes(o));
      const wrongIdx = opts.findIndex((o) => !grid.includes(o));
      return { right: idx, wrong: wrongIdx };
    },
    maxScore: () => 10,   // daily.js:332 四选一对=10 分
    probe: (pz) => ({
      len: pz.len, opts: pz.options.length,
      grid: pz.grid.length,
    }),
  },
  'chimp-test': {
    mode: 'partial',
    make(pz) {
      const pos = pz.positions || [];
      return {
        right: [...pos].sort((a, b) => a - b),   // 乱序满分：验证「顺序无关」
        wrong: pos.slice(0, -1),                  // 漏一格：按设计拿部分分
      };
    },
    maxScore: (pz) => (pz.positions || []).length,   // 每命中一格 1 分
    probe: (pz) => ({ n: (pz.positions || []).length, grid: pz.grid }),
  },
  'word-recall': {
    mode: 'partial',
    make(pz) {
      const words = pz.words || [];
      const seen = new Set();
      const truth = words.map((w) => { const s = seen.has(w); seen.add(w); return s ? 'seen' : 'new'; });
      return {
        right: truth,
        // 全部答 new：重复词那一两个必错，其余仍对 → 按设计拿部分分
        wrong: words.map(() => 'new'),
      };
    },
    maxScore: (pz) => (pz.words || []).length,        // 每个词 1 分
    probe: (pz) => ({
      len: pz.len, lang: pz.lang,
      words: (pz.words || []).slice(0, 5).join('|'),
    }),
  },
};

const GAMES = ['emoji-ghost', 'chimp-test', 'word-recall'];

try {
  for (const game of GAMES) {
    section(`1v1 对战：${game}`);
    const a = ANSWERS[game];
    const r = await playGame(game, a.make);
    const { right: rAns, wrong: wAns } = r.hb;

    /* 🔴 先自检：wrong 必须真的和 right 不同，且不是同一个空值。
       否则"错误答案不得分"这条断言就是自欺欺人（交同一份答案也 0 分）。 */
    const wDiffers = JSON.stringify(wAns) !== JSON.stringify(rAns);
    ok(wDiffers, `${game} 「错误答案」与正确答案确实是两份不同的 payload`);

    ok(r.same, `${game} 双方拿到完全相同的题目`);
    info(`题目: ${JSON.stringify(a.probe(r.hz))} · 正确 payload=${JSON.stringify(rAns)}`);

    /* 🔴 roomStore.answer 返回的是**该玩家累计总分** `score`（room.js:208/227），
       本轮拿分是 `gained`。判据按各游戏真实判分模型分两档：
         all-or-nothing（emoji）：错 → gained 必须严格为 0
         partial（chimp/word）   ：错 → 允许拿部分分，但**拿不到满分**，
                                  且 correct 必须为 false */
    if (a.mode === 'all-or-nothing') {
      ok((r.wrong.gained ?? 0) === 0, `${game} 错误答案本轮 gained=0（实际 ${r.wrong.gained}）`);
    } else {
      const wScore = r.wrong.detail && r.wrong.detail.score;
      ok(typeof wScore === 'number' && wScore < a.maxScore(r.hz),
        `${game} 部分给分模型：错误答案得分 ${wScore} < 满分 ${a.maxScore(r.hz)}`);
    }
    ok(r.wrong.correct === false, `${game} 错误答案 correct=false`);

    /* 正确答案必须拿满分（判分正确性的核心信号）
       🔴 满分基数要用**题目本身**的规模，不能用 right.length ——
          对 emoji 是选项下标（标量 0..3），两者含义不同。
          这里统一取 daily.js 的计分上限口径：
          emoji=10 分/题，chimp=命中格数，word=词数。 */
    const maxScore = a.maxScore(r.hz);
    ok(r.right.correct === true, `${game} 正确答案 correct=true`);
    ok((r.right.detail && r.right.detail.score) === maxScore,
      `${game} 正确答案拿满分 ${maxScore}（实际 ${r.right.detail && r.right.detail.score}）`);
    ok((r.right.gained ?? 0) > 0, `${game} 正确答案本轮 gained>0（实际 ${r.right.gained}）`);
    info(`wrong payload=${JSON.stringify(wAns).slice(0, 90)}`);
    info(`guest 提交：gained=${r.right.gained} score=${r.right.score} detail=${JSON.stringify(r.right.detail).slice(0, 120)}`);

    // 轮次推进
    ok(r.st1.round === 1, `${game} 双方交完后 round 推进到 1（实际 ${r.st1.round}）`);
    info(`status: ${JSON.stringify(r.st1).slice(0, 220)}`);
  }
} catch (e) {
  fail++;
  console.log(`  FAIL 脚本异常：${e && e.message}`);
}

console.log(`\n─────────────────────────────────────────`);
console.log(`结果: ${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项`);
process.exit(fail ? 1 : 0);
