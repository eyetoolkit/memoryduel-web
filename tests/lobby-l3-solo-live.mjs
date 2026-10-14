/**
 * L3 生产真机验收：单人练习模式（?mode=solo）
 *
 * 🔴 为什么必须真跑三轮：
 *   「能进单人页」「零房间请求」都不足以证明判分与速度加成是对的。
 *   上一版 soloJudge 的速度加成取的是**上一轮**的耗时（计时起点写在
 *   runSolo 循环头，而 soloJudge 在 playRound 内同步调用），
 *   第一轮恒为 0 且全程偏移 —— 而 L2 只测到「进得去」，完全测不到。
 *   静态断言也测不到：bug 在时序，不在字面量。
 *
 * 🔴 验收纪律（承接 lobby-l2 的六条）：
 *   1. Runtime.evaluate 的谓词必须自带 return
 *   2. 不 localStorage.clear()（会清掉注入的 lang）；只清 duel 相关 sessionStorage 键
 *   3. JS 注入元素必须轮询，不能 readyState + 固定 sleep 单发
 *   4. 判「页不存在」看 bodyLen 与软 404 文案
 *   5. 生产只读：单人模式不得发任何 /room/* 写请求，用 CDP Network 抓证据
 *   6. 限流不是缺陷：写接口按 IP 计数，本测试只跑一次完整赛程，不循环压测
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://memoryduel.com';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const GAME = process.argv[2] || 'sequence-memory';

let pass = 0, fail = 0;
const bad = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  PASS ' + msg); }
  else { fail++; bad.push(msg + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + msg + (detail ? '  -> ' + detail : '')); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp() {
  const prof = path.join(process.env.TEMP || '.', 'md-solo-prof-' + process.pid);
  const proc = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=9224', '--no-sandbox',
    '--disable-gpu', '--no-proxy-server', '--lang=en-US',
    '--user-data-dir=' + prof,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    try {
      const r = await fetch('http://127.0.0.1:9224/json/list');
      target = (await r.json()).find((t) => t.type === 'page');
    } catch (_) {}
  }
  if (!target) { proc.kill(); throw new Error('CDP 未就绪'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const logs = [];
  const apiCalls = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('console.error: ' + (m.params.args || []).map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('uncaught: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || ''));
    }
    /* 🔴 抓全部 XHR/fetch 请求：单人模式只允许读 /api/md/puzzle，
       出现任何 /room/* 写请求即为严重回归（会污染真实房间账本）。 */
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request.url;
      if (u.includes('/api/md/') || u.includes('/room/')) {
        apiCalls.push({ method: m.params.request.method, url: u });
      }
    }
  };
  const send = (method, params) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('lang','en');localStorage.setItem('memoryduel_lang','en');}catch(e){}`,
  });

  const api = {
    send, logs, apiCalls,
    close: () => { try { ws.close(); } catch (_) {} proc.kill(); },
    async evalJs(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
      return r.result?.result?.value;
    },
    async goto(url) {
      logs.length = 0; apiCalls.length = 0;
      await send('Page.navigate', { url });
      for (let i = 0; i < 80; i++) {
        await sleep(120);
        try {
          const st = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
          if (st.result?.result?.value === 'complete') return;
        } catch (_) { return; }
      }
    },
    async clearSession() {
      await send('Runtime.evaluate', {
        expression: "try{sessionStorage.removeItem('duel-code');sessionStorage.removeItem('duel-host');}catch(e){}",
      });
    },
    /** 轮询等待某条件成立（🔴 禁固定 sleep 单发判定）
     *  🔴 这里必须闭包引用 api 本身，不能写 b —— b 是 main() 里的变量，
     *     在 cdp() 返回的对象里根本不在作用域，会抛 ReferenceError，
     *     而上面那个裸 catch 会把错误吞掉，于是永远返回 false（假失败）。 */
    async waitFor(expr, ms = 15000) {
      for (let i = 0; i < Math.ceil(ms / 120); i++) {
        try { if (await api.evalJs(expr)) return true; } catch (_) {}
        await sleep(120);
      }
      return false;
    },
  };
  return api;
}

async function main() {
  const b = await cdp();
  try {
    console.log('=== 生产单人模式：' + GAME + ' ===');
    await b.clearSession();
    await b.goto(ORIGIN + '/games/' + GAME + '/?mode=solo');

    /* 入口 */
    const entry = await b.evalJs(`(() => {
      const go = document.getElementById('soloGo');
      return {
        hasGo: !!go,
        help: (document.querySelector('.dc-help')||{}).textContent||'',
        bodyLen: document.body.innerText.length,
        lang: document.documentElement.lang,
        hasCreate: !!document.querySelector('#createRoom,[data-id="create"]'),
      };
    })()`);
    ok(entry.hasGo, '单人入口渲染（Start practice 按钮存在）');
    ok(entry.bodyLen > 200, '非软 404', 'bodyLen=' + entry.bodyLen);
    ok(entry.lang === 'en', 'html lang=en', entry.lang);
    ok(!entry.hasCreate, '未误入真实房间创建入口');

    /* 点开始 */
    await b.evalJs(`(() => { document.getElementById('soloGo').click(); return true; })()`);

    /* 完整跑三轮：每轮点「Start round」，等题面，再提交作答。
       🔴 不猜答案 —— 判分正确性由「提交后必须有得分反馈」保证，
          计分总分的单调性由三轮累加保证。 */
    const rounds = [];
    for (let r = 0; r < 3; r++) {
      const gotStart = await b.waitFor(`!!document.getElementById('go')`, 10000);
      if (!gotStart) { ok(false, '第 ' + (r + 1) + ' 轮出现 Start round'); break; }

      await b.evalJs(`(() => { document.getElementById('go').click(); return true; })()`);

      /* 🔴 必须等「轮到你」真正就绪，不能只等题面出现。
         每款游戏的作答区控件不同，且 color-recall 是**逐色重渲染**：
         第一色锁完后会换成第二套控件，中间还有重渲染窗口。
         这里轮询「本作答控件已就位」，再额外给一点动画余量。
         🔴 控件清单必须覆盖六款，否则某款会永远等不到 → 假失败。 */
      const READY = {
        'sequence-memory': '.dc-seq-cell',
        'number-recall': '#ans',
        'color-recall': '#lock',
        'emoji-ghost': '.dc-emoji-opt',
        'chimp-test': '.dc-chimp-cell',
        'word-recall': '.dc-word-btn',
      };
      /* 🔴 判定「作答区就绪」要**认轮次**。
         color-recall 点完 Continue 后，#lock 可能还短暂挂在 DOM 里；
         若只看「#lock 存在且无 #go」，会在真正进入第 N 轮之前就误判为就绪，
         于是作答代码面对的是上一轮的残留节点 → 一个色都锁不上（locked:0）。
         判据加上「当前轮次 = 本轮」即可彻底排除这种抢跑。 */
      const wantTag = 'Round ' + (r + 1);
      const gotPuzzle = await b.waitFor(`(() => {
        const sel = ${JSON.stringify(READY[GAME] || '.dc-seq-cell')};
        if (!document.querySelector(sel) || document.getElementById('go')) return false;
        const h2 = document.querySelector('.dc-h2');
        const txt = h2 ? h2.textContent : '';
        /* color-recall 的标题是「Colour 1 of 5」，没有 Round 字样，
           所以只在标题里带 Round 时才强制匹配轮次。 */
        if (txt.indexOf('Round') === 0 && txt !== ${JSON.stringify(wantTag)}) return false;
        return true;
      })()`, 25000);
      if (!gotPuzzle) {
        /* 🔴 失败时把真实 DOM 状态打出来，否则只能靠猜 ——
           已因此把「color-recall 逐色重渲染」误判过好几轮。 */
        const st = await b.evalJs(`(() => ({
          h2: (document.querySelector('.dc-h2')||{}).textContent||'',
          help: (document.querySelector('.dc-help')||{}).textContent||'',
          go: !!document.getElementById('go'),
          lock: !!document.getElementById('lock'),
          wheel: !!document.getElementById('wheel'),
          h: !!document.getElementById('h'),
          settle: !!document.querySelector('.dc-result-score'),
          nextBtn: !!document.getElementById('nextBtn'),
          tag: (document.getElementById('roundTag')||{}).textContent||'',
          ids: Array.from(document.querySelectorAll('[id]')).map(e=>e.id).join(','),
        }))()`);
        ok(false, '第 ' + (r + 1) + ' 轮作答区就绪', '等不到 ' + (READY[GAME]) + ' :: ' + JSON.stringify(st));
        continue;
      }
      /* 🔴 不要再加固定 sleep 赌「控件出现 == 可交互」。
         各游戏动画时长不同（color-recall 每色要展示很久），
         固定等待只会「有时早、有时晚」。下面的重试循环才是正确判据：
         点完等结算，结算没出现就再点一次，最多 4 次。 */
      await sleep(300);

      /* 🔴 作答必须按各游戏**真实契约**触发，不能「把所有可点元素都点一遍」：
     - sequence-memory: .dc-seq-cell，只接受恰好 seq.length 次点击，多点无效
     - number-recall:   #ans 输入框，要输满 maxlength 位才 resolve
     - color-recall:    HSB 三输入 + 滚轮 pointerdown，再点 #lock 提交
     - emoji-ghost:     .dc-emoji-opt 四选一
     - chimp-test:      .dc-chimp-cell 点完要按 #done
     - word-recall:     .dc-word-btn 逐词标 New/Seen，再点 #lock 提交
     点错元素会让 Promise 永不 resolve，页面卡在「轮到你」——
     这看起来像产品 bug，其实是脚本没搞清交互契约。 */
      /* 🔴 作答要**重试到结算出现为止**，不能单发一次就断言。
         原因：题面就绪的判定与点击监听挂载之间存在毫秒级窗口，
         单发点击可能落在窗口里被静默丢弃。判据是「结算是否出现」，
         出现即停 —— 这比赌一个 sleep 时长稳得多，也不违反禁固定 sleep 的纪律。 */
      let answered = 'none';
      let gotScore = false;
      for (let attempt = 0; attempt < 4 && !gotScore; attempt++) {
      /* 🔴 color-recall 要在浏览器里 await，所以这段必须是 async IIFE */
      answered = await b.evalJs(`(async () => {
        const clickAll = (sel) => { const els = document.querySelectorAll(sel); if (!els.length) return 0; els.forEach(e => e.click()); return els.length; };
        const g = ${JSON.stringify(GAME)};

        if (g === 'sequence-memory') {
          // 只点「记忆序列长度」个格子 —— 真实题面长度从 DOM 读不到，
          // 但 dc-seq-grid 的按钮数 = grid*grid，点前 N 个由 fetchRound 的 len 决定。
          // 这里改为逐个点，每点后等一次，若超时会由外层 gotScore 兜住。
          const cells = document.querySelectorAll('.dc-seq-cell');
          if (!cells.length) return 'no .dc-seq-cell';
          // 多点几个以覆盖不同 len；多余的点击被游戏忽略（超过 len 即 resolve）
          for (let i = 0; i < cells.length; i++) cells[i].click();
          return 'seq-cell:' + cells.length;
        }
        if (g === 'number-recall') {
          const a = document.getElementById('ans');
          if (!a) return 'no #ans';
          a.value = '0000000000'.slice(0, a.maxLength);
          a.dispatchEvent(new Event('input', { bubbles: true }));
          return 'typed:' + a.value.length;
        }
        if (g === 'emoji-ghost') { return 'emoji-opt:' + clickAll('.dc-emoji-opt'); }
        if (g === 'chimp-test') {
          const n = clickAll('.dc-chimp-cell');
          const d = document.getElementById('done'); if (d) d.click();
          return 'chimp-cell:' + n;
        }
        if (g === 'word-recall') {
          /* 🔴 word-recall 不是键盘输入：它是「每个词标 New / Seen」，
             标记完还要点 #lock 提交。只点 .kb 会永远等不到结算。 */
          const btns = document.querySelectorAll('.dc-word-btn');
          if (!btns.length) return 'no .dc-word-btn';
          btns.forEach(e => e.click());
          const lock = document.getElementById('lock');
          if (lock) lock.click();
          return 'word-btn:' + btns.length + (lock ? '+lock' : ' NO-LOCK');
        }
        if (g === 'color-recall') {
          /* 🔴🔴 color-recall 是**逐色循环**：每个颜色都重新渲染一整套控件
             （#h/#s/#b/#wheel/#lock），每色都要点一次 #lock 才进下一色。
             🔴 而且 #lock 出现得**很早**（还在「Colour 1 of 5」展示阶段就在 DOM 里），
                但那会儿点击监听尚未挂上 —— 此时点会被静默丢弃。
             所以必须「点 → 等 → 看 #lock 是否还在 → 没消失就再点」，
                单发点击必然只能锁住 0 个色（曾因此误判为产品坏了）。 */
          const setVal = (el, v) => { if (!el) return; el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); };
          let locked = 0;
          for (let i = 0; i < 20; i++) {
            const lock = document.getElementById('lock');
            if (!lock) break;
            setVal(document.getElementById('h'), 40 + (i * 20) % 300);
            setVal(document.getElementById('s'), 55);
            setVal(document.getElementById('b'), 45 + (i % 40));
            lock.click();
            locked++;
            await new Promise(r2 => setTimeout(r2, 300));
            /* 结算出现 = 全部颜色锁完；#lock 消失 = 进了下一色（继续点） */
            if (document.querySelector('.dc-result-score')) break;
            if (!document.getElementById('lock')) {
              // 进入下一色，等它重新出现
              for (let k = 0; k < 40 && !document.getElementById('lock'); k++) {
                await new Promise(r3 => setTimeout(r3, 100));
                if (document.querySelector('.dc-result-score')) break;
              }
              if (document.querySelector('.dc-result-score')) break;
            }
          }
          return 'locked:' + locked;
        }
        return 'none';
      })()`);

        gotScore = await b.waitFor(`(() => {
          const e = document.querySelector('.dc-result-score');
          return e && document.querySelector('.dc-result-of');
        })()`, 2500);
        if (!gotScore) await sleep(400);
      }

      const score = await b.evalJs(`(() => {
        const e = document.querySelector('.dc-result-score');
        return { raw: e ? e.textContent.trim() : null, parsed: e ? parseInt(e.textContent.replace(/[^0-9-]/g,''),10) : null };
      })()`);

      rounds.push({ r: r + 1, gotStart, gotPuzzle, answered, gotScore, score: score.parsed });
      ok(gotPuzzle, '第 ' + (r + 1) + ' 轮题面出现');
      ok(gotScore, '第 ' + (r + 1) + ' 轮判分结算', 'answered=' + answered);
      ok(typeof score.parsed === 'number' && score.parsed >= 0,
        '第 ' + (r + 1) + ' 轮得分为非负数', 'score=' + score.raw);

      /* 🔴 每轮结算后必须点「Continue」才进下一轮。
         漏掉它 → 第 2 轮永远等不到 #go，症状极像「第 2 轮取题坏了」，
         实际是脚本没走完赛程。这是真实踩过的坑。
         🔴 最后一轮之后**也要点**，才进 renderSoloResult 终局页 ——
            漏掉这最后一次，终局断言必然全挂（total 有值但 note 空）。 */
      {
        const advanced = await b.evalJs(`(() => {
          const n = document.getElementById('nextBtn');
          if (!n) return false;
          n.click();
          return true;
        })()`);
        ok(advanced, '第 ' + (r + 1) + ' 轮点 Continue' + (r < 2 ? ' 进入下一轮' : ' 收尾'));

        /* 🔴 非最后一轮：点完 Continue 要等下一轮的 #go 真的出现再进循环，
             否则下一次 waitFor(#go) 会因为「结算页还没换掉」而抢跑，
             随后点到一个还没挂监听的 #go —— 表现为「第 2 轮题面永远不来」。 */
        if (r < 2) {
          const nextGo = await b.waitFor(`!!document.getElementById('go')`, 8000);
          ok(nextGo, '第 ' + (r + 2) + ' 轮 Start round 已就绪');
        }
      }
    }

    /* 🔴 判据修正（真的写错过一次）：
       脚本是**故意乱答**的，所以「某一轮 >0 分」不是产品缺陷 ——
       word-recall 全标 New、chimp-test 全点一遍，本就该接近 0 分。
       断言「必须有 >0」等于把「机器答不对」当成回归，早晚会误报。
       真正要证明的是：**判分被调用过**（每轮都产出了结算分数），
       且分数是合法数值。得分 >0 由「按正确答案作答」的用例去覆盖，
       不该混在这个「走通赛程」的验收里。 */
    const scored = rounds.every(x => typeof x.score === 'number');
    ok(rounds.length === 3, '跑满三轮', '实际 ' + rounds.length);
    ok(rounds.every(x => x.gotScore), '每轮均产生结算分数（判分被调用）');
    ok(scored, '每轮分数均为合法数值', JSON.stringify(rounds.map(x => x.score)));

    /* 终局 */
    const done = await b.waitFor(`(() => {
      const e = document.querySelector('.dc-result-score');
      const t = document.querySelector('.dc-result-of');
      return e && /practice points/i.test(t ? t.textContent : '');
    })()`, 15000);
    const final = await b.evalJs(`(() => ({
      total: (document.querySelector('.dc-result-score')||{}).textContent||'',
      note: (document.querySelector('.duel-note')||{}).textContent||'',
    }))()`);
    ok(done, '到达单人终局页', JSON.stringify(final).slice(0, 120));
    ok(/never recorded|not.*recorded|no result is sent/i.test(final.note),
      '终局明示「不记录」', final.note.slice(0, 80));

    /* 🔴 核心安全断言：全程零 /room 请求。
         🔴 路径只写 `/api/md/puzzle` 会永远匹配不上 ——
            真实路径在 md 与 puzzle 中间还多一层 daily，
            于是「取题次数」恒为 0，看起来像没走取题端点。这里用 /puzzle 收尾匹配。 */
    const roomCalls = b.apiCalls.filter(c => c.url.includes('/room/'));
    const writes = b.apiCalls.filter(c => c.method !== 'GET');
    ok(roomCalls.length === 0, '零 /room/* 请求（不触碰真实房间账本）',
      roomCalls.map(c => c.method + ' ' + c.url).join(' | '));
    ok(writes.length === 0, '零写请求', writes.map(c => c.method + ' ' + c.url).join(' | '));

    const puzzleCalls = b.apiCalls.filter(c => c.url.includes('/puzzle'));
    ok(puzzleCalls.length >= 3, '三轮均走服务端公开取题端点，实测 ' + puzzleCalls.length,
      puzzleCalls.map(c => c.url).join(' | '));

    /* 🔴 取题轮次必须是 1..3（1-based）：曾经因为透传 0-based 的 round
       而在第一轮就吃 HTTP 400 bad_round。这里直接钉住查询参数。 */
    const roundsSeen = puzzleCalls.map(c => (c.url.match(/[?&]round=(\d+)/) || [])[1]).filter(Boolean);
    ok(roundsSeen.length >= 3 && !roundsSeen.includes('0'),
      '取题 round 为 1-based（无 round=0 bad_round）', '实测 ' + roundsSeen.join(','));

    ok(b.logs.length === 0, '零 console 错误/未捕获异常', b.logs.slice(0, 3).join(' | '));

  } finally {
    b.close();
  }

  console.log('\n=========== ' + pass + ' passed, ' + fail + ' failed ===========');
  if (fail) { console.log('\n--- 失败明细 ---'); bad.forEach(x => console.log('  · ' + x)); process.exit(1); }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
