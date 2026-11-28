/* ============================================================
   /quiz/* — 主题题库页答题器（2026-11-28）
   ------------------------------------------------------------
   职责：只做「把 #qz-data 里的题渲染成可点的答题器」这一件事。
   页面静态部分（标题、导语、答案区、相关主题、内链）全部在
   HTML 里，本脚本失效时页面依然是一份完整的答案页 —— 这是
   刻意设计：爬虫与无 JS 环境拿到的东西和有 JS 时一样多。

   数据格式（由 scripts/quiz/gen-quiz-pages.mjs 写入）：
     { "t": "主题名", "q": [[题干, [选项...], 正确下标, 解析], ...] }
   ============================================================ */
(function () {
  'use strict';

  var host = document.getElementById('qz-app');
  var dataEl = document.getElementById('qz-data');
  if (!host || !dataEl) return; /* 总览页等无答题器的页面直接退出 */

  var DATA;
  try {
    DATA = JSON.parse(dataEl.textContent);
  } catch (e) {
    host.innerHTML = '<p class="qz-note">This quiz could not be loaded. The full answer key is below.</p>';
    return;
  }
  var QS = DATA && DATA.q;
  if (!QS || !QS.length) return;

  var i = 0;
  var score = 0;
  var locked = false;

  var KEY = ['A', 'B', 'C', 'D', 'E', 'F'];

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  function render() {
    host.innerHTML = '';
    var q = QS[i];

    var top = el('div', 'qz-top');
    top.appendChild(el('span', null, 'Question ' + (i + 1) + ' / ' + QS.length));
    var sc = el('span', 'qz-score', 'Score ' + score);
    top.appendChild(sc);
    host.appendChild(top);

    var bar = el('div', 'qz-bar');
    var fill = el('i');
    fill.style.width = (i / QS.length) * 100 + '%';
    bar.appendChild(fill);
    host.appendChild(bar);

    host.appendChild(el('p', 'qz-qt', q[0]));

    var list = el('ul', 'qz-opts');
    var btns = [];
    q[1].forEach(function (opt, k) {
      var li = el('li');
      var b = el('button', 'qz-opt');
      b.type = 'button';
      b.appendChild(el('span', 'k', KEY[k] || String(k + 1)));
      b.appendChild(el('span', null, opt));
      b.addEventListener('click', function () { pick(k); });
      btns.push(b);
      li.appendChild(b);
      list.appendChild(li);
    });
    host.appendChild(list);

    var fb = el('div', 'qz-fb');
    fb.hidden = true;
    var verdict = el('p', 'qz-verdict');
    var exp = el('p', 'qz-exp');
    fb.appendChild(verdict);
    fb.appendChild(exp);
    host.appendChild(fb);

    var actions = el('div', 'qz-actions');
    var next = el('button', 'qz-btn', i === QS.length - 1 ? 'See my score' : 'Next question');
    next.type = 'button';
    next.hidden = true;
    next.addEventListener('click', advance);
    actions.appendChild(next);
    host.appendChild(actions);

    function pick(k) {
      if (locked) return;
      locked = true;
      var ok = k === q[2];
      if (ok) score++;
      sc.textContent = 'Score ' + score;

      btns.forEach(function (b, bi) {
        b.disabled = true;
        if (bi === q[2]) b.classList.add('is-ok');
        else if (bi === k) b.classList.add('is-no');
        else b.classList.add('is-dim');
      });

      verdict.className = 'qz-verdict ' + (ok ? 'ok' : 'no');
      verdict.textContent = ok ? 'Correct' : 'Not quite — answer: ' + (KEY[q[2]] || q[2] + 1);
      exp.textContent = q[3] || '';
      exp.hidden = !q[3];
      fb.hidden = false;
      next.hidden = false;
      next.focus({ preventScroll: true });
    }

    function advance() {
      i++;
      locked = false;
      if (i >= QS.length) return finish();
      render();
      var wrap = document.querySelector('.qz-card');
      if (wrap && wrap.getBoundingClientRect().top < 0) {
        wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    host._pick = pick;
    host._next = next;
  }

  function finish() {
    host.innerHTML = '';
    /* 清掉上一题的闭包引用：否则结算页按数字键/回车会调到已经卸载的
       按钮上，分数被凭空改掉而界面毫无反应。 */
    host._pick = null;
    host._next = null;
    var pct = Math.round((score / QS.length) * 100);
    var box = el('div', 'qz-result');

    var big = el('div', 'big');
    big.appendChild(document.createTextNode(String(score)));
    var small = el('small', null, ' / ' + QS.length);
    big.appendChild(small);
    box.appendChild(big);

    var title = el('h3');
    title.textContent =
      pct === 100 ? 'Perfect run' :
      pct >= 80 ? 'Strong run' :
      pct >= 50 ? 'Solid start' : 'Room to climb';
    box.appendChild(title);

    var msg = el('p');
    msg.textContent =
      pct === 100 ? 'Every answer right. Try the same topic in a live 1v1 and see how speed changes things.' :
      pct >= 80 ? 'You know this shelf. The ones you missed are in the answer key above.' :
      pct >= 50 ? 'Half the shelf is solid. Read the explanations above, then run it again.' :
      'Worth reading the answer key above — the explanations are the useful part.';
    box.appendChild(msg);
    host.appendChild(box);

    var actions = el('div', 'qz-actions');

    var again = el('button', 'qz-btn ghost', 'Play again');
    again.type = 'button';
    again.addEventListener('click', function () {
      i = 0; score = 0; locked = false; render();
    });
    actions.appendChild(again);

    var share = el('button', 'qz-btn ghost', 'Copy link');
    share.type = 'button';
    share.addEventListener('click', function () {
      var url = location.origin + location.pathname;
      var done = function () {
        share.textContent = 'Link copied';
        setTimeout(function () { share.textContent = 'Copy link'; }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, done);
      } else {
        var t = document.createElement('textarea');
        t.value = url; document.body.appendChild(t); t.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(t); done();
      }
    });
    actions.appendChild(share);

    var duel = el('a', 'qz-btn', 'Duel someone live');
    duel.href = '/games/knowledge-duel/lobby/';
    actions.appendChild(duel);

    host.appendChild(actions);

    var key = el('p', 'qz-note');
    key.style.marginTop = '14px';
    key.textContent = 'The fifteen answers with explanations are in the answer key right above.';
    host.appendChild(key);
  }

  document.addEventListener('keydown', function (e) {
    if (!host._pick) return;
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    var k = e.key;
    var idx = -1;
    if (/^[1-6]$/.test(k)) idx = Number(k) - 1;
    else if (/^[a-f]$/i.test(k)) idx = k.toLowerCase().charCodeAt(0) - 97;
    if (idx >= 0) {
      var btns = host.querySelectorAll('.qz-opt');
      if (btns[idx] && !btns[idx].disabled) btns[idx].click();
      return;
    }
    if ((k === 'Enter' || k === ' ') && host._next && !host._next.hidden) {
      e.preventDefault();
      host._next.click();
    }
  });

  render();
})();
