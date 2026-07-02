/* ===== PHP шпаргалка — UI, рендер, взаимодействие (данные из API) ===== */
(function () {
  'use strict';
  var api = window.SOBES.api;
  var engine = window.SOBES.search;

  var CATS = [], ITEMS = [];
  var CHUNK = 70;

  var ICON_PIN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
  var ICON_EDIT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  var ACT_TPL = document.createElement('div');
  ACT_TPL.className = 'card-actions';
  ACT_TPL.innerHTML = '<button class="ico pin" type="button">' + ICON_PIN + '</button><button class="ico edit" type="button">' + ICON_EDIT + '</button>';

  // --- markdown (мини) ---
  function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function mdInline(s) {
    s = escHtml(s);
    s = s.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return s;
  }
  function mdBlock(text) {
    var lines = (text || '').split('\n'), html = '', list = false, para = [];
    function flushP() { if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = []; } }
    function flushL() { if (list) { html += '</ul>'; list = false; } }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i], m = ln.match(/^\s*[-*]\s+(.*)$/);
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln)) { flushP(); flushL(); html += '<hr>'; }
      else if (m) { flushP(); if (!list) { html += '<ul>'; list = true; } html += '<li>' + mdInline(m[1]) + '</li>'; }
      else if (!ln.trim()) { flushL(); flushP(); }
      else { flushL(); para.push(mdInline(ln)); }
    }
    flushL(); flushP();
    return html;
  }

  // --- подсветка синтаксиса (лениво) ---
  var KW = {};
  ('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null int float string bool void self parent mixed never object iterable ' +
   'select from where join inner left right outer full cross on group by order having limit offset insert into values update set delete create table index alter drop primary key foreign references distinct union all between like in exists when then end asc desc count sum avg min max with over partition rank row_number begin commit rollback transaction ' +
   'let var function return if else for while const new class extends import export default await async yield typeof instanceof this null true false undefined')
    .split(/\s+/).forEach(function (k) { KW[k] = 1; });
  var HL = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|--[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\$[A-Za-z_]\w*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)(?=\s*\()|([A-Za-z_]\w*)|(===|!==|==|<=>|->|=>|::|\?\?|[+\-*/%.=<>!&|?:]+)/g;
  function highlightCode(code) {
    var out = '', last = 0, m; HL.lastIndex = 0;
    while ((m = HL.exec(code))) {
      if (m.index > last) out += escHtml(code.slice(last, m.index));
      var txt = escHtml(m[0]), cls;
      if (m[1]) cls = 'tok-com'; else if (m[2]) cls = 'tok-str'; else if (m[3]) cls = 'tok-var';
      else if (m[4]) cls = 'tok-num'; else if (m[5]) cls = KW[m[5].toLowerCase()] ? 'tok-kw' : 'tok-fn';
      else if (m[6]) cls = KW[m[6].toLowerCase()] ? 'tok-kw' : null; else if (m[7]) cls = 'tok-op';
      out += cls ? '<span class="' + cls + '">' + txt + '</span>' : txt;
      last = HL.lastIndex; if (m.index === HL.lastIndex) HL.lastIndex++;
    }
    out += escHtml(code.slice(last));
    return out;
  }
  function ensureHl(pre) { if (pre && !pre._hl) { pre.innerHTML = highlightCode(pre._code); pre._hl = true; } }

  // --- подсветка совпадений ---
  function highlightMatches(root, ts) {
    if (!ts.length) return;
    var uniq = ts.filter(function (t, i) { return t && ts.indexOf(t) === i; });
    var re = new RegExp('(' + uniq.map(engine.escRe).sort(function (a, b) { return b.length - a.length; }).join('|') + ')', 'gi');
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode;
        if (p && (p.nodeName === 'CODE' || p.nodeName === 'PRE' || (p.classList && (p.classList.contains('badge') || p.classList.contains('edited'))))) return NodeFilter.FILTER_REJECT;
        return re.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var nodes = [], n; while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(function (node) {
      var frag = document.createDocumentFragment(), s = node.nodeValue, mm, li = 0; re.lastIndex = 0;
      while ((mm = re.exec(s))) {
        if (mm.index > li) frag.appendChild(document.createTextNode(s.slice(li, mm.index)));
        var mk = document.createElement('mark'); mk.textContent = mm[0]; frag.appendChild(mk);
        li = re.lastIndex; if (mm.index === re.lastIndex) re.lastIndex++;
      }
      if (li < s.length) frag.appendChild(document.createTextNode(s.slice(li)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  // --- DOM ---
  var els = {
    q: document.getElementById('q'), clear: document.getElementById('clear'),
    results: document.getElementById('results'), cats: document.getElementById('cats'),
    counter: document.getElementById('counter'), empty: document.getElementById('empty'),
    stat: document.getElementById('stat-line'), unpinAll: document.getElementById('unpinAll'),
    modal: document.getElementById('modal'), modalTitle: document.getElementById('modal-title'),
    modalBody: document.getElementById('modal-body'), modalEdit: document.getElementById('modal-edit')
  };
  els.modalEdit.innerHTML = ICON_EDIT;
  var state = { query: '', cat: '*', sel: -1 };
  var cardEls = [];

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }
  function shortCat(t) { return (t || '').length > 18 ? t.slice(0, 17) + '…' : t; }

  function buildSidebar() {
    var counts = {}; ITEMS.forEach(function (it) { counts[it.cat] = (counts[it.cat] || 0) + 1; });
    var html = catBtn('*', 'Все категории', ITEMS.length);
    CATS.forEach(function (c) { html += catBtn(c.key, c.title, counts[c.key] || 0); });
    els.cats.innerHTML = html;
    els.stat.textContent = ITEMS.length + ' ' + plural(ITEMS.length, 'карточка', 'карточки', 'карточек') + ' · ' + CATS.length + ' тем';
  }
  function catBtn(key, title, n) {
    return '<button class="cat" data-cat="' + key + '"><span class="cat-dot"></span>' +
      '<span class="cat-name">' + escHtml(title) + '</span><span class="cat-count">' + n + '</span></button>';
  }

  function enterEdit(card, it) {
    card.classList.add('editing'); card.innerHTML = '';
    var w = document.createElement('div'); w.className = 'edit';
    w.innerHTML =
      '<label>Вопрос</label><textarea class="e-q" rows="2"></textarea>' +
      '<label>Короткий ответ <span class="hint">видно сразу; markdown ок</span></label><textarea class="e-a" rows="3"></textarea>' +
      '<label>Развёрнутый ответ <span class="hint">по кнопке «Подробнее»</span></label><textarea class="e-detail" rows="6"></textarea>' +
      '<label>Код <span class="hint">необязательно</span></label><textarea class="e-code" rows="4" spellcheck="false"></textarea>' +
      '<div class="edit-btns"><button class="btn primary" type="button">Сохранить</button><button class="btn cancel" type="button">Отмена</button>' +
      (it.edited ? '<button class="btn ghost reset" type="button">Вернуть оригинал</button>' : '') + '</div>';
    card.appendChild(w);
    var eq = w.querySelector('.e-q'), ea = w.querySelector('.e-a'), ed = w.querySelector('.e-detail'), ec = w.querySelector('.e-code');
    eq.value = it.q; ea.value = it.a; ed.value = it.detail || ''; ec.value = it.code || '';
    eq.focus();
    w.querySelector('.primary').onclick = function () {
      var old = { q: it.q, a: it.a, detail: it.detail, code: it.code, edited: it.edited };
      it.q = eq.value.trim(); it.a = ea.value; it.detail = ed.value; it.code = ec.value; it.edited = true;
      engine.reindex(it); render();
      api.saveEdit(it.id, { q: it.q, a: it.a, detail: it.detail, code: it.code }).catch(function () {
        it.q = old.q; it.a = old.a; it.detail = old.detail; it.code = old.code; it.edited = old.edited;
        engine.reindex(it); render(); alert('Не удалось сохранить правку');
      });
    };
    w.querySelector('.cancel').onclick = function () { render(); };
    var rb = w.querySelector('.reset');
    if (rb) rb.onclick = function () {
      api.reset(it.id).then(function (res) {
        var c = res.card || {};
        if (c.q != null) it.q = c.q; if (c.a != null) it.a = c.a;
        if (c.detail != null) it.detail = c.detail; if (c.code != null) it.code = c.code;
        if (c.tags) it.tags = c.tags;
        it.edited = false; engine.reindex(it); render();
      }).catch(function () { alert('Не удалось вернуть оригинал'); });
    };
  }

  function openDetail(card) {
    if (!card._wrap || !card._wrap.classList.contains('hide')) return;
    card._wrap.classList.remove('hide');
    if (card._pre) ensureHl(card._pre);
    card._more.textContent = 'Свернуть';
    card.classList.add('open');
  }
  function closeDetail(card) {
    if (!card._wrap || card._wrap.classList.contains('hide')) return;
    card._wrap.classList.add('hide');
    card._more.textContent = 'Подробнее';
    card.classList.remove('open');
  }
  function toggleDetail(card) {
    if (!card._wrap) return;
    if (card._wrap.classList.contains('hide')) openDetail(card); else closeDetail(card);
  }

  function makeCard(it, hl, withBadge) {
    var card = document.createElement('article'); card.className = 'card'; card.dataset.id = it.id;
    if (it.pinned) card.classList.add('pinned');

    var act = ACT_TPL.cloneNode(true);
    var pin = act.children[0], ed = act.children[1];
    if (it.pinned) pin.classList.add('on');
    pin.title = it.pinned ? 'Открепить' : 'Закрепить наверх';
    ed.title = 'Редактировать';
    pin.onclick = function (e) {
      e.stopPropagation();
      it.pinned = !it.pinned; render();
      api.setPin(it.id, it.pinned).catch(function () { it.pinned = !it.pinned; render(); alert('Не удалось сохранить закреп'); });
    };
    ed.onclick = function (e) { e.stopPropagation(); enterEdit(card, it); };
    card.appendChild(act);

    var q = document.createElement('div'); q.className = 'q';
    if (withBadge) { var b = document.createElement('span'); b.className = 'badge'; b.textContent = shortCat(it.catTitle); q.appendChild(b); }
    if (it.edited) { var mk = document.createElement('span'); mk.className = 'edited'; mk.title = 'Изменено вами'; mk.textContent = 'ред.'; q.appendChild(mk); }
    var qt = document.createElement('span'); qt.className = 'qtext'; qt.innerHTML = mdInline(it.q); q.appendChild(qt);
    card.appendChild(q);

    var a = document.createElement('div'); a.className = 'a'; a.innerHTML = mdBlock(it.a); card.appendChild(a);

    var hasDetail = it.detail && it.detail.trim();
    var hasCode = it.code && it.code.trim();
    if (hasDetail || hasCode) {
      var more = document.createElement('button'); more.className = 'more'; more.type = 'button'; more.textContent = 'Подробнее';
      more.onclick = function () { toggleDetail(card); };
      var wrap = document.createElement('div'); wrap.className = 'detail-wrap hide';
      if (hasDetail) { var d = document.createElement('div'); d.className = 'detail'; d.innerHTML = mdBlock(it.detail); wrap.appendChild(d); card._detailEl = d; }
      if (hasCode) {
        var pre = document.createElement('pre'); pre.className = 'code'; pre._code = it.code; pre._hl = false; pre.textContent = it.code;
        wrap.appendChild(pre); card._pre = pre;
      }
      card.appendChild(more); card.appendChild(wrap);
      card._more = more; card._wrap = wrap;
    }
    if (hl.length) {
      highlightMatches(q, hl); highlightMatches(a, hl);
      if (card._detailEl) highlightMatches(card._detailEl, hl);
    }
    return card;
  }

  function updateUnpin() {
    if (!els.unpinAll) return;
    var n = ITEMS.filter(function (i) { return i.pinned; }).length;
    els.unpinAll.hidden = n === 0;
    els.unpinAll.textContent = 'Снять все закрепы' + (n ? ' (' + n + ')' : '');
  }

  var renderTimer = null;
  function render() {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    var hl = engine.highlightList(state.query);
    var list = engine.run(state.query, state.cat);
    // на главной без поиска — только закреплённые; поиск и категории — по всем
    var pinnedOnly = !state.query && state.cat === '*';
    if (pinnedOnly) list = list.filter(function (it) { return it.pinned; });

    els.results.innerHTML = ''; cardEls = []; state.sel = -1;
    updateUnpin();

    if (!list.length) {
      els.empty.hidden = false;
      els.empty.innerHTML = pinnedOnly
        ? '<b>Здесь будут закреплённые вопросы</b><span>Нажми 📌 на карточке (открой категорию или поиск), чтобы держать её тут под рукой. А пока — ищи по всем темам или выбери категорию слева.</span>'
        : '<b>Ничего не нашлось</b>';
    } else els.empty.hidden = true;

    els.counter.textContent = list.length
      ? (state.query
          ? list.length + ' ' + plural(list.length, 'совпадение', 'совпадения', 'совпадений')
          : (pinnedOnly ? 'Закреплённые · ' : '') + list.length + ' ' + plural(list.length, 'карточка', 'карточки', 'карточек'))
      : '';

    var plan = [], grouped = pinnedOnly;
    if (grouped) {
      var byCat = {}; list.forEach(function (it) { (byCat[it.cat] = byCat[it.cat] || []).push(it); });
      CATS.forEach(function (c) {
        var arr = byCat[c.key]; if (!arr || !arr.length) return;
        plan.push({ head: c, n: arr.length });
        arr.forEach(function (it) { plan.push({ item: it, badge: false }); });
      });
    } else {
      list.forEach(function (it) { plan.push({ item: it, badge: state.cat === '*' }); });
    }
    renderPlan(plan, hl);
    els.results.scrollTop = 0;
  }

  function renderPlan(plan, hl) {
    var i = 0;
    function step() {
      var frag = document.createDocumentFragment();
      var end = Math.min(i + CHUNK, plan.length);
      for (; i < end; i++) {
        var u = plan[i];
        if (u.head) {
          var h = document.createElement('div'); h.className = 'cat-head';
          h.innerHTML = '<h2>' + escHtml(u.head.title) + '</h2><span class="n">' + u.n + '</span>';
          frag.appendChild(h);
        } else {
          var el = makeCard(u.item, hl, u.badge); cardEls.push(el); frag.appendChild(el);
        }
      }
      els.results.appendChild(frag);
      if (i < plan.length) renderTimer = setTimeout(step, 0); else renderTimer = null;
    }
    step();
  }

  function setCat(key) {
    state.cat = key;
    Array.prototype.forEach.call(els.cats.children, function (b) { b.classList.toggle('active', b.getAttribute('data-cat') === key); });
    render();
  }

  function moveSel(delta) {
    if (!cardEls.length) return;
    var n = state.sel + delta; if (n < 0) n = 0; if (n >= cardEls.length) n = cardEls.length - 1;
    if (state.sel >= 0 && cardEls[state.sel]) cardEls[state.sel].classList.remove('sel');
    state.sel = n; var el = cardEls[n]; el.classList.add('sel'); el.scrollIntoView({ block: 'nearest' });
  }
  function toggleSelDetail() {
    if (state.sel < 0) { if (cardEls.length) moveSel(1); }
    var el = cardEls[state.sel]; if (el && el._more) toggleDetail(el);
  }

  function clearSearch() { els.q.value = ''; state.query = ''; els.clear.hidden = true; render(); }

  var typeTimer = null;
  function onType() {
    state.query = els.q.value; els.clear.hidden = !state.query;
    if (typeTimer) clearTimeout(typeTimer);
    typeTimer = setTimeout(function () { typeTimer = null; render(); }, 45);
  }

  els.q.addEventListener('input', onType);
  els.clear.addEventListener('click', function () { clearSearch(); els.q.focus(); });
  els.cats.addEventListener('click', function (e) { var b = e.target.closest('.cat'); if (b) setCat(b.getAttribute('data-cat')); });
  els.unpinAll.addEventListener('click', function () {
    var prev = ITEMS.filter(function (i) { return i.pinned; });
    prev.forEach(function (i) { i.pinned = false; });
    render();
    api.clearPins().catch(function () { prev.forEach(function (i) { i.pinned = true; }); render(); alert('Не удалось снять закрепы'); });
  });

  // --- попап «о себе» / «сложная задача» ---
  var curPersonal = null;
  function openModal(key) {
    var p = (window.PERSONAL || {})[key]; if (!p) return;
    curPersonal = key;
    els.modalTitle.textContent = p.title || '';
    els.modalBody.innerHTML = mdBlock(p.body || '');
    els.modalEdit.hidden = false;
    els.modal.hidden = false;
  }
  function editPersonalForm() {
    var key = curPersonal; if (!key) return;
    var p = (window.PERSONAL || {})[key] || { title: '', body: '' };
    els.modalEdit.hidden = true;
    els.modalTitle.textContent = 'Правка: ' + (p.title || key);
    els.modalBody.innerHTML = '';
    var f = document.createElement('div'); f.className = 'pedit';
    f.innerHTML =
      '<label>Заголовок</label><input class="pe-title" type="text">' +
      '<label>Текст <span class="hint">markdown ок: **жирный**, `код`, «- » список</span></label><textarea class="pe-body" rows="12"></textarea>' +
      '<div class="edit-btns"><button class="btn primary pe-save" type="button">Сохранить</button><button class="btn pe-cancel" type="button">Отмена</button></div>';
    els.modalBody.appendChild(f);
    f.querySelector('.pe-title').value = p.title || '';
    f.querySelector('.pe-body').value = p.body || '';
    f.querySelector('.pe-save').onclick = function () {
      var t = f.querySelector('.pe-title').value, b = f.querySelector('.pe-body').value;
      window.PERSONAL[key] = { title: t, body: b };
      api.editPersonal(key, { title: t, body: b }).catch(function () { alert('Не удалось сохранить'); });
      openModal(key);
    };
    f.querySelector('.pe-cancel').onclick = function () { openModal(key); };
  }
  function closeModal() { els.modal.hidden = true; }
  Array.prototype.forEach.call(document.querySelectorAll('.personal .pbtn'), function (b) {
    b.addEventListener('click', function () { openModal(b.getAttribute('data-personal')); });
  });
  els.modalEdit.addEventListener('click', editPersonalForm);
  els.modal.addEventListener('click', function (e) { if (e.target.getAttribute('data-close')) closeModal(); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && els.modal && !els.modal.hidden) { closeModal(); return; }
    if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
    var inInput = document.activeElement === els.q;
    if (e.key === '/' && !inInput) { e.preventDefault(); els.q.focus(); return; }
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); els.q.focus(); els.q.select(); return; }
    if (e.key === 'Escape') {
      if (state.query) clearSearch();
      else if (state.cat !== '*') setCat('*');
      else els.q.blur();
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); toggleSelDetail(); }
  });

  // --- старт: грузим данные из API ---
  els.stat.textContent = 'загрузка…';
  api.load().then(function (data) {
    CATS = data.categories || []; ITEMS = data.items || []; window.PERSONAL = data.personal || {};
    window.SOBES._items = ITEMS;
    engine.prepare(ITEMS);
    buildSidebar();
    setCat('*');
    els.q.focus();
  }).catch(function (e) {
    els.stat.textContent = 'ошибка загрузки';
    els.empty.hidden = false;
    els.empty.innerHTML = '<b>Не удалось загрузить данные</b><span>' + escHtml(e && e.message || '') + '</span>';
  });
})();
