(function() {
  var el = document.getElementById("topRankList");
  if (!el) return;
  var tierEmoji = {"bronze":"&#x1F949;","silver":"&#x1F948;","gold":"&#x1F947;","platinum":"&#x1F3C6;","diamond":"&#x1F48E;"};
  var tierColor = {"bronze":"#CD7F32","silver":"#C0C0C0","gold":"#FFD700","platinum":"#00D4FF","diamond":"#B9F2FF"};
  function render(list) {
    if (!list || !list.length) { el.innerHTML = '<div class="tr-empty" data-i18n="home.rank_empty">No players ranked yet</div>'; return; }
    var h = '';
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var t = p.tier || 'bronze';
      var tColor = tierColor[t] || '#999';
      var tEmoji = tierEmoji[t] || '&#x1F3C5;';
      var rank = p.rank || (i+1);
      h += '<div class="tr-card">' +
        '<div class="tr-rank" style="color:' + tColor + '">' + tEmoji + ' #' + rank + '</div>' +
        '<div class="tr-ava" style="background:linear-gradient(135deg,' + tColor + ',color-mix(in srgb,' + tColor + ' 50%,#000))">' + (p.name ? p.name.charAt(0).toUpperCase() : '?') + '</div>' +
        '<div class="tr-name">' + (p.name || 'Anonymous') + '</div>' +
        '<div class="tr-rating">&#x1F3C5; ' + (p.rating || 0) + '</div>' +
        '<div class="tr-tier" style="color:' + tColor + '">' + (t.charAt(0).toUpperCase() + t.slice(1)) + '</div></div>';
    }
    el.innerHTML = h;
  }
  fetch((window.API_BASE || '') + '/md/rank?limit=10').then(function(r){return r.json();}).then(function(d){
    if (d && d.ok && d.list) render(d.list);
    else el.innerHTML = '<div class="tr-empty">Rankings unavailable</div>';
  }).catch(function(){ el.innerHTML = '<div class="tr-empty">Rankings unavailable</div>'; });
})();