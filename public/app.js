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
    if (suffMain && pinnedOnly) { updateUnpin(); suffShow(); return; } // суфлёр вместо закрепов
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

  var Q_PLACEHOLDER = els.q.getAttribute('placeholder') || '';
  function clearSearch() {
    els.q.value = ''; els.clear.hidden = true;
    if (suffMain) { suffLastPhrase = ''; suffLastQuery = ''; suffShow(); return; }
    state.query = ''; render();
  }

  var typeTimer = null;
  function onType() {
    els.clear.hidden = !els.q.value;
    if (typeTimer) clearTimeout(typeTimer);
    if (suffMain) { // в режиме суфлёра основной инпут ищет умным поиском суфлёра (suffPick)
      typeTimer = setTimeout(function () {
        typeTimer = null; var v = els.q.value.trim();
        if (!v) { suffLastPhrase = ''; suffLastQuery = ''; suffShow(); }
        else { suffLastQuery = ''; suffRender(v); }
      }, 120);
      return;
    }
    state.query = els.q.value;
    typeTimer = setTimeout(function () { typeTimer = null; render(); }, 45);
  }

  els.q.addEventListener('input', onType);
  els.clear.addEventListener('click', function () { clearSearch(); els.q.focus(); });
  els.cats.addEventListener('click', function (e) {
    var b = e.target.closest('.cat'); if (!b) return;
    if (location.hash) location.hash = '';
    setCat(b.getAttribute('data-cat'));
  });
  els.unpinAll.addEventListener('click', function () {
    var prev = ITEMS.filter(function (i) { return i.pinned; });
    prev.forEach(function (i) { i.pinned = false; });
    render();
    api.clearPins().catch(function () { prev.forEach(function (i) { i.pinned = true; }); render(); alert('Не удалось снять закрепы'); });
  });

  // --- попап «Текущая вакансия»: все личные заготовки в одном окне ---
  var PERSONAL_SECTIONS = [
    { key: 'self', icon: '👤', label: 'Расскажи о себе' },
    { key: 'task', icon: '💡', label: 'Сложная / интересная задача' },
    { key: 'jobs', icon: '🏢', label: 'Последние 3 места работы' },
    { key: 'ask',  icon: '❓', label: 'Вопросы (что спросить)' }
  ];
  function personalSection(s) {
    var p = (window.PERSONAL || {})[s.key] || { title: '', body: '' };
    var sec = document.createElement('section'); sec.className = 'psec';
    var head = document.createElement('div'); head.className = 'psec-head';
    var t = document.createElement('h3'); t.className = 'psec-title'; t.textContent = s.icon + ' ' + (p.title || s.label);
    var ed = document.createElement('button'); ed.className = 'psec-edit'; ed.type = 'button'; ed.title = 'Редактировать'; ed.setAttribute('aria-label', 'Редактировать');
    ed.innerHTML = ICON_EDIT;
    ed.onclick = function () { editPersonalSection(s); };
    head.appendChild(t); head.appendChild(ed);
    var body = document.createElement('div'); body.className = 'psec-body';
    body.innerHTML = (p.body && p.body.trim()) ? mdBlock(p.body) : '<span class="psec-empty">пусто — нажми ✎, чтобы заполнить</span>';
    sec.appendChild(head); sec.appendChild(body);
    return sec;
  }
  function openVacancy() {
    els.modalTitle.textContent = '📋 Текущая вакансия';
    els.modalEdit.hidden = true;              // правка теперь по секциям
    els.modalBody.innerHTML = '';
    PERSONAL_SECTIONS.forEach(function (s) { els.modalBody.appendChild(personalSection(s)); });
    els.modal.hidden = false;
    els.modalBody.scrollTop = 0;
  }
  function editPersonalSection(s) {
    var p = (window.PERSONAL || {})[s.key] || { title: '', body: '' };
    els.modalTitle.textContent = 'Правка: ' + s.label;
    els.modalBody.innerHTML = '';
    var f = document.createElement('div'); f.className = 'pedit';
    f.innerHTML =
      '<label>Заголовок</label><input class="pe-title" type="text">' +
      '<label>Текст <span class="hint">markdown ок: **жирный**, `код`, «- » список</span></label><textarea class="pe-body" rows="12"></textarea>' +
      '<div class="edit-btns"><button class="btn primary pe-save" type="button">Сохранить</button><button class="btn pe-cancel" type="button">← Назад</button></div>';
    els.modalBody.appendChild(f);
    f.querySelector('.pe-title').value = p.title || '';
    f.querySelector('.pe-body').value = p.body || '';
    f.querySelector('.pe-save').onclick = function () {
      var t = f.querySelector('.pe-title').value, b = f.querySelector('.pe-body').value;
      window.PERSONAL[s.key] = { title: t, body: b };
      api.editPersonal(s.key, { title: t, body: b }).catch(function () { alert('Не удалось сохранить'); });
      openVacancy();
    };
    f.querySelector('.pe-cancel').onclick = function () { openVacancy(); };
  }
  function closeModal() { els.modal.hidden = true; }
  var openVacancyBtn = document.getElementById('openVacancy');
  if (openVacancyBtn) openVacancyBtn.addEventListener('click', openVacancy);
  els.modal.addEventListener('click', function (e) { if (e.target.getAttribute('data-close')) closeModal(); });

  // --- мониторинг вакансий: отдельная страница (роут #monitoring) ---
  var monView = document.getElementById('monitoring-view');
  var cheatView = document.getElementById('cheatsheet-view');
  var sideMain = document.getElementById('sidebar-main');
  var sideMon = document.getElementById('sidebar-mon');
  var srcList = document.getElementById('src-list');
  var srcFile = document.getElementById('src-file');
  var srcUrl = document.getElementById('src-url');
  var srcLogin = document.getElementById('src-login');
  var srcPassword = document.getElementById('src-password');
  var fieldsTg = document.getElementById('src-fields-tg');
  var fieldsAccount = document.getElementById('src-fields-account');
  var srcKind = 'tg';

  function route() {
    var mon = location.hash === '#monitoring';
    if (mon && suffMain) suffStop(); // уходя в мониторинг — глушим суфлёр
    cheatView.hidden = mon;
    monView.hidden = !mon;
    sideMain.hidden = mon;
    sideMon.hidden = !mon;
    if (mon) { loadTgFiles(); loadSources(); loadVacancies(); loadAnalyzeStatus(); loadNotifications(); }
  }
  var backHome = document.getElementById('backHome');
  if (backHome) backHome.addEventListener('click', function (e) { e.preventDefault(); location.hash = ''; });

  var allTgFiles = [], curSources = [];
  function fillFileSelect() {
    var added = {};
    curSources.forEach(function (s) { if (s.kind === 'tg') added[s.value] = 1; });
    var avail = allTgFiles.filter(function (f) { return !added[f]; });
    srcFile.innerHTML = '';
    if (!avail.length) {
      var o = document.createElement('option'); o.value = '';
      o.textContent = allTgFiles.length ? 'все файлы уже добавлены' : 'нет файлов в .claude/tg_history';
      o.disabled = true; srcFile.appendChild(o); return;
    }
    avail.forEach(function (f) { var op = document.createElement('option'); op.value = f; op.textContent = f; srcFile.appendChild(op); });
  }
  function loadTgFiles() {
    api.listTgFiles().then(function (files) { allTgFiles = files; fillFileSelect(); })
      .catch(function () { srcFile.innerHTML = '<option value="" disabled>ошибка списка файлов</option>'; });
  }
  function loadSources() {
    srcList.innerHTML = '<div class="src-empty">Загрузка…</div>';
    api.listSources().then(function (list) { curSources = list; renderSources(list); fillFileSelect(); })
      .catch(function () { srcList.innerHTML = '<div class="src-empty">Ошибка загрузки</div>'; });
  }
  function srcRow(s) {
    var row = document.createElement('div'); row.className = 'src-row';
    var ic = s.kind === 'account' ? '🌐 ' : '📨 ';
    var main = document.createElement('div'); main.className = 'src-main';
    var t = document.createElement('div'); t.className = 'src-t'; t.textContent = ic + (s.title || s.value || '(без названия)'); t.title = s.value;
    main.appendChild(t);
    if (s.kind === 'account') {
      var v = document.createElement('div'); v.className = 'src-v';
      v.textContent = (s.login ? '👤 ' + s.login : s.value) + (s.hasPassword ? ' 🔒' : '');
      main.appendChild(v);
    }
    var auto = document.createElement('button'); auto.type = 'button';
    auto.className = 'src-auto' + (s.autoApply ? ' on' : '');
    auto.textContent = s.autoApply ? '🤖 авто' : '🤖 вручную';
    auto.title = s.autoApply
      ? 'Автоотклик ВКЛ — откликаюсь сам без подтверждения на релевантные вакансии этого источника'
      : 'Автоотклик выкл — сначала черновик и твоё одобрение';
    auto.onclick = function () {
      var on = !s.autoApply;
      if (on && !confirm('Включить АВТООТКЛИК для "' + (s.title || s.value) + '"?\n\nЯ буду сам откликаться на подходящие вакансии из этого источника БЕЗ твоего подтверждения.')) return;
      api.setAutoApply(s.id, on).then(loadSources).catch(loadSources);
    };
    var del = document.createElement('button'); del.type = 'button'; del.className = 'src-del'; del.textContent = '✕'; del.title = 'Удалить';
    del.onclick = function () { api.deleteSource(s.id).then(loadSources).catch(loadSources); };
    row.appendChild(main); row.appendChild(auto); row.appendChild(del);
    return row;
  }
  function renderSources(list) {
    srcList.innerHTML = '';
    if (!list.length) { srcList.innerHTML = '<div class="src-empty">Пока нет источников — добавь выше.</div>'; return; }
    [['tg', '📨 Телеграм-чаты'], ['account', '🌐 Аккаунты / сайты']].forEach(function (g) {
      var items = list.filter(function (s) { return s.kind === g[0]; });
      if (!items.length) return;
      var h = document.createElement('div'); h.className = 'src-group'; h.textContent = g[1] + ' (' + items.length + ')';
      srcList.appendChild(h);
      items.forEach(function (s) { srcList.appendChild(srcRow(s)); });
    });
  }
  Array.prototype.forEach.call(monView.querySelectorAll('.src-tab'), function (tab) {
    tab.addEventListener('click', function () {
      srcKind = tab.getAttribute('data-kind');
      Array.prototype.forEach.call(monView.querySelectorAll('.src-tab'), function (t) { t.classList.toggle('active', t === tab); });
      var isAcc = srcKind === 'account';
      fieldsTg.hidden = isAcc; fieldsAccount.hidden = !isAcc;
    });
  });
  document.getElementById('src-add-btn').addEventListener('click', function () {
    var payload;
    if (srcKind === 'account') {
      var url = srcUrl.value.trim();
      if (!url) { srcUrl.focus(); return; }
      payload = { kind: 'account', title: url, value: url, login: srcLogin.value.trim(), password: srcPassword.value };
    } else {
      var file = srcFile.value;
      if (!file) { alert('Нет доступного файла (возможно, все уже добавлены)'); return; }
      payload = { kind: 'tg', title: file, value: file };
    }
    api.addSource(payload).then(function (res) {
      if (res && res.existed) { alert('Такой источник уже добавлен'); return; }
      srcUrl.value = ''; srcLogin.value = ''; srcPassword.value = '';
      loadSources();
    }).catch(function () { alert('Не удалось добавить источник'); });
  });
  // --- найденные вакансии ---
  var vacList = document.getElementById('vac-list');
  var vacFilter = 'new', vacSource = 'all', allVacs = [];
  var VAC_FILTERS = [
    { key: 'new',     label: '🆕 Новые',        match: function (v) { return v.applyStatus === 'new'; } },
    { key: 'drafts',  label: '✍️ Черновики',    match: function (v) { return v.applyStatus === 'queued' || v.applyStatus === 'approved'; } },
    { key: 'applied', label: '✅ Откликнулся',  match: function (v) { return v.applyStatus === 'applied'; } },
    { key: 'manual',  label: '✋ Нужна форма',  match: function (v) { return v.applyStatus === 'needs_manual'; } },
    { key: 'skipped', label: '⏭ Пропущенные',  match: function (v) { return v.applyStatus === 'skipped'; } }
  ];
  function curFilter() { for (var i = 0; i < VAC_FILTERS.length; i++) if (VAC_FILTERS[i].key === vacFilter) return VAC_FILTERS[i]; return VAC_FILTERS[0]; }
  function statusMatch(v) { return curFilter().match(v); }
  function sourceMatch(v) { return vacSource === 'all' || String(v.sourceId) === vacSource; }
  function bothMatch(v)   { return statusMatch(v) && sourceMatch(v); }
  // список источников, реально присутствующих в выдаче (в порядке появления)
  function vacSources() {
    var map = {}, order = [];
    allVacs.forEach(function (v) {
      var id = v.sourceId ? String(v.sourceId) : '';
      if (!id) return;
      if (!map[id]) { map[id] = { id: id, label: v.chat || ('источник #' + id) }; order.push(map[id]); }
    });
    return order;
  }
  function loadVacancies() {
    if (!vacList) return;
    api.listVacancies().then(function (list) { allVacs = list || []; applyVacFilter(); })
      .catch(function () { vacList.innerHTML = '<div class="src-empty">Ошибка загрузки</div>'; });
  }
  function applyVacFilter() {
    // выбранный источник опустел под текущим статусом → вернуть на «Все»
    if (vacSource !== 'all' && !allVacs.filter(bothMatch).length) vacSource = 'all';
    // статус опустел под текущим источником → на первый непустой
    if (!allVacs.filter(bothMatch).length) {
      var fne = VAC_FILTERS.filter(function (f) { return allVacs.filter(function (v) { return f.match(v) && sourceMatch(v); }).length; })[0];
      if (fne) vacFilter = fne.key;
    }
    renderFilters();
    renderSourceFilter();
    renderVacancies(allVacs.filter(bothMatch));
  }
  function renderFilters() { // статус-фильтры (сайдбар); счётчики в рамках выбранного источника
    var host = document.getElementById('vac-filters'); if (!host) return;
    host.innerHTML = '';
    VAC_FILTERS.forEach(function (f) {
      var n = allVacs.filter(function (v) { return f.match(v) && sourceMatch(v); }).length;
      if (!n) return; // пустые статусы не показываем
      var b = document.createElement('button'); b.type = 'button';
      b.className = 'vac-filter' + (vacFilter === f.key ? ' active' : '');
      var t = document.createElement('span'); t.className = 'vf-name'; t.textContent = f.label;
      var c = document.createElement('span'); c.className = 'vf-count'; c.textContent = n;
      b.appendChild(t); b.appendChild(c);
      b.onclick = function () { vacFilter = f.key; applyVacFilter(); };
      host.appendChild(b);
    });
  }
  function renderSourceFilter() { // фильтр по источникам (строка над списком); счётчики в рамках выбранного статуса
    var host = document.getElementById('vac-stats'); if (!host) return;
    host.innerHTML = '';
    var chips = [{ id: 'all', label: 'Все' }].concat(vacSources());
    chips.forEach(function (s) {
      var n = s.id === 'all'
        ? allVacs.filter(statusMatch).length
        : allVacs.filter(function (v) { return statusMatch(v) && String(v.sourceId) === s.id; }).length;
      if (s.id !== 'all' && !n) return; // источник без вакансий под этим статусом скрываем, «Все» всегда
      var b = document.createElement('button'); b.type = 'button';
      b.className = 'vac-src' + (vacSource === s.id ? ' active' : '');
      var t = document.createElement('span'); t.className = 'vs-name'; t.textContent = s.label;
      var c = document.createElement('span'); c.className = 'vs-count'; c.textContent = n;
      b.appendChild(t); b.appendChild(c);
      b.onclick = function () { vacSource = s.id; applyVacFilter(); };
      host.appendChild(b);
    });
  }
  var APPLY_BADGE = {
    queued:       ['✍️ черновик готов', 'q'],
    approved:     ['⏳ одобрено', 'a'],
    applied:      ['✅ откликнулся', 'ok'],
    needs_manual: ['✋ нужна форма', 'm'],
    skipped:      ['⏭ пропущена', 's']
  };
  function vbtn(text, cls, on) {
    var b = document.createElement('button'); b.type = 'button';
    b.className = 'btn' + (cls ? ' ' + cls : ''); b.textContent = text; b.onclick = on; return b;
  }
  // поиск сайта/раздела вакансий компании ВНЕ источника
  function companySearchUrl(v) {
    var q = (v.company || v.title || '').trim();
    return 'https://www.google.com/search?q=' +
      encodeURIComponent(q + ' вакансии карьера официальный сайт -site:hh.ru -site:career.habr.com -site:superjob.ru');
  }
  function applyBadge(v) {
    var b = APPLY_BADGE[v.applyStatus]; if (!b) return null; // 'new' — без бейджа
    var el = document.createElement('span'); el.className = 'vac-badge b-' + b[1]; el.textContent = b[0];
    if (v.applyStatus === 'applied' && v.appliedAt) el.title = 'откликнулся: ' + new Date(v.appliedAt).toLocaleString('ru');
    return el;
  }
  // блок под карточкой: черновик+одобрение / ручная форма / ожидание отправки
  function applyBlock(v) {
    var st = v.applyStatus;
    if (st === 'queued') {
      var box = document.createElement('div'); box.className = 'vac-apply';
      if (v.coverLetter) {
        var lbl = document.createElement('div'); lbl.className = 'vac-apply-lbl'; lbl.textContent = '✉️ Сопроводительное (черновик)';
        var pre = document.createElement('pre'); pre.className = 'vac-cover'; pre.textContent = v.coverLetter;
        box.appendChild(lbl); box.appendChild(pre);
      }
      var row = document.createElement('div'); row.className = 'vac-apply-btns';
      row.appendChild(vbtn('✅ Одобрить отправку', 'primary', function () { api.approveApply(v.id).then(loadVacancies).catch(loadVacancies); }));
      row.appendChild(vbtn('⏭ Пропустить', '', function () { api.skipApply(v.id).then(loadVacancies).catch(loadVacancies); }));
      box.appendChild(row); return box;
    }
    if (st === 'needs_manual') {
      var box2 = document.createElement('div'); box2.className = 'vac-apply need';
      var n = document.createElement('div'); n.className = 'vac-apply-note'; n.textContent = '✋ Нужна твоя рука: ' + (v.applyNote || 'внешняя форма/тест');
      box2.appendChild(n);
      var row2 = document.createElement('div'); row2.className = 'vac-apply-btns';
      row2.appendChild(vbtn('✓ Я откликнулся', 'primary', function () { api.markApplied(v.id).then(loadVacancies).catch(loadVacancies); }));
      row2.appendChild(vbtn('⏭ Пропустить', '', function () { api.skipApply(v.id).then(loadVacancies).catch(loadVacancies); }));
      box2.appendChild(row2); return box2;
    }
    if (st === 'approved') {
      var box3 = document.createElement('div'); box3.className = 'vac-apply wait';
      box3.textContent = '⏳ Одобрено — отправлю отклик при следующем прогоне';
      return box3;
    }
    return null;
  }
  function renderVacancies(list) {
    var cnt = document.getElementById('vac-count');
    if (cnt) cnt.textContent = list.length ? '(' + list.length + ')' : '';
    vacList.innerHTML = '';
    if (!list.length) {
      vacList.innerHTML = '<div class="src-empty">Пока нет подходящих вакансий.</div>';
      return;
    }
    list.forEach(function (v) {
      var card = document.createElement('article'); card.className = 'vac'; card.id = 'vac-' + v.id;
      var head = document.createElement('div'); head.className = 'vac-h';
      var sc = document.createElement('span'); sc.className = 'vac-score' + (v.score >= 85 ? ' hi' : ''); sc.textContent = v.score + '%';
      var tt = document.createElement('div'); tt.className = 'vac-t'; tt.textContent = v.title || '(без названия)';
      var del = document.createElement('button'); del.type = 'button'; del.className = 'src-del'; del.textContent = '✕'; del.title = 'Убрать';
      del.onclick = function () { api.deleteVacancy(v.id).then(loadVacancies).catch(loadVacancies); };
      head.appendChild(sc); head.appendChild(tt);
      var bdg = applyBadge(v); if (bdg) head.appendChild(bdg);
      head.appendChild(del);
      card.appendChild(head);
      if (v.reason) { var r = document.createElement('div'); r.className = 'vac-r'; r.textContent = v.reason; card.appendChild(r); }
      if (v.mismatches && v.mismatches.length) {
        var mm = document.createElement('div'); mm.className = 'vac-miss';
        var mh = document.createElement('div'); mh.className = 'vac-miss-h'; mh.textContent = '⚠ Несоответствия';
        mm.appendChild(mh);
        var ul = document.createElement('ul');
        v.mismatches.forEach(function (t) { var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
        mm.appendChild(ul); card.appendChild(mm);
      }
      var isWeb = v.kind === 'account';
      var meta = document.createElement('div'); meta.className = 'vac-m'; meta.textContent = (isWeb ? '🌐 ' : '📨 ') + v.chat;
      if (v.link) { meta.appendChild(document.createTextNode('   ')); var a = document.createElement('a'); a.href = v.link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '🔗 открыть'; meta.appendChild(a); }
      meta.appendChild(document.createTextNode('   '));
      var find = document.createElement('a'); find.className = 'vac-find';
      find.href = v.companyUrl || companySearchUrl(v); find.target = '_blank'; find.rel = 'noopener';
      find.textContent = v.companyUrl ? '🏢 сайт компании' : '🔎 искать компанию';
      find.title = v.company ? (v.companyUrl ? 'Открыть: ' + v.company : 'Найти сайт/вакансии: ' + v.company) : 'Поиск по названию вакансии';
      meta.appendChild(find);
      card.appendChild(meta);
      if (v.text || v.linkText) {
        var moreLbl = isWeb ? 'Описание вакансии' : 'Текст сообщения';
        var more = document.createElement('button'); more.type = 'button'; more.className = 'more'; more.textContent = moreLbl;
        var box = document.createElement('div'); box.className = 'vac-text hide';
        if (v.text) {
          var l1 = document.createElement('div'); l1.className = 'vac-text-lbl'; l1.textContent = isWeb ? 'Кратко' : 'Пост в телеграме';
          var p1 = document.createElement('pre'); p1.className = 'vac-pre'; p1.textContent = v.text; box.appendChild(l1); box.appendChild(p1);
        }
        if (v.linkText) {
          var l2 = document.createElement('div'); l2.className = 'vac-text-lbl'; l2.textContent = isWeb ? 'Полное описание' : 'Описание по ссылке';
          var p2 = document.createElement('pre'); p2.className = 'vac-pre'; p2.textContent = v.linkText; box.appendChild(l2); box.appendChild(p2);
        }
        more.onclick = function () { var h = box.classList.toggle('hide'); more.textContent = h ? moreLbl : 'Скрыть'; };
        card.appendChild(more); card.appendChild(box);
      }
      var ab = applyBlock(v); if (ab) card.appendChild(ab);
      vacList.appendChild(card);
    });
  }
  function loadAnalyzeStatus() {
    var el = document.getElementById('analyze-status'); if (!el) return;
    api.analyzeStatus().then(function (s) {
      el.textContent = (s && s.last && s.last.at) ? 'последний прогон: ' + new Date(s.last.at).toLocaleString('ru') : '';
    }).catch(function () {});
  }
  // --- колокольчик уведомлений ---
  var bellBtn = document.getElementById('bell');
  var bellPanel = document.getElementById('bell-panel');
  var bellCount = document.getElementById('bell-count');
  function loadNotifications() {
    if (!bellBtn) return;
    api.notifications().then(renderNotifications).catch(function () {});
  }
  function renderNotifications(data) {
    var n = (data && data.unread) || 0;
    if (bellCount) { bellCount.textContent = n; bellCount.hidden = n === 0; }
    bellBtn.classList.toggle('has-unread', n > 0);
    if (!bellPanel) return;
    var items = (data && data.items) || [];
    bellPanel.innerHTML = '';
    var head = document.createElement('div'); head.className = 'bell-head';
    var ttl = document.createElement('span'); ttl.textContent = 'Уведомления'; head.appendChild(ttl);
    if (items.length) {
      var clr = document.createElement('button'); clr.type = 'button'; clr.className = 'bell-clear'; clr.textContent = 'прочитать все';
      clr.onclick = function () { api.markNotifRead().then(loadNotifications).catch(loadNotifications); };
      head.appendChild(clr);
    }
    bellPanel.appendChild(head);
    if (!items.length) { var e = document.createElement('div'); e.className = 'bell-empty'; e.textContent = 'Пусто'; bellPanel.appendChild(e); return; }
    items.forEach(function (it) {
      var row = document.createElement('div'); row.className = 'bell-item' + (it.read ? ' read' : '');
      var t = document.createElement('div'); t.className = 'bell-item-t'; t.textContent = it.title || '(без названия)';
      var b = document.createElement('div'); b.className = 'bell-item-b'; b.textContent = it.body || '';
      row.appendChild(t); row.appendChild(b);
      row.onclick = function () {
        api.markNotifRead(it.id).then(loadNotifications).catch(loadNotifications);
        if (it.vacancyId) { var c = document.getElementById('vac-' + it.vacancyId); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        bellPanel.hidden = true;
      };
      bellPanel.appendChild(row);
    });
  }
  if (bellBtn) {
    bellBtn.addEventListener('click', function (e) { e.stopPropagation(); bellPanel.hidden = !bellPanel.hidden; });
    document.addEventListener('click', function (e) {
      if (bellPanel && !bellPanel.hidden && !bellPanel.contains(e.target) && e.target !== bellBtn) bellPanel.hidden = true;
    });
  }

  // ================= 🎧 Суфлёр: звук вкладки → распознавание → ответы из базы =================
  var suff = {
    toggle: document.getElementById('suff-toggle'),
    bar: document.getElementById('suff-bar'),
    status: document.getElementById('suff-status'),
    trans: document.getElementById('suff-transcript'),
    ptt: document.getElementById('suff-ptt')
  };
  var suffMain = false, suffLastPhrase = '';
  var SUFF_N = 4;
  // стоп-слова + разговорный мусор — чтобы из вопроса вытащить только смысловые термины
  var SUFF_STOP = {};
  ('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по ее мне было вот от меня о из ему когда даже ну ли если уже или ни быть был него до вас уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без чего раз тоже себе под будет тогда кто этот того потому этого какой ним здесь этом один мой тем чтобы нее сейчас были куда зачем всех можно при два об другой хоть после над больше тот через эти нас про всего них какая много три эту моя этой перед лучше чуть том такой им более всегда всю между это твой ваш какие каких нам вообще нужно тебе есть расскажи расскажите опиши опишите объясни объясните скажи давай давайте вопрос например пожалуйста знаешь понимаешь значит типа вот такой так вот')
    .split(/\s+/).forEach(function (w) { SUFF_STOP[w] = 1; });

  // словарь концептов: как бы собеседник/распознавалка ни сказали термин (аббревиатура, полная фраза,
  // латиница, «на слух») → бустим нужную категорию и добавляем чистые термины в поиск.
  // hit — нормализованные ПОДСТРОКИ фразы (по основе, чтобы ловить окончания). cat — ключ категории для буста.
  var SUFF_CONCEPTS = [
    { hit: ['ооп', 'oop', 'объектно ориентир', 'объектно-ориентир'], cat: 'oop', add: ['ооп'] },
    { hit: ['инкапсуляц'], cat: 'oop', add: ['инкапсуляция'] },
    { hit: ['полиморф'], cat: 'oop', add: ['полиморфизм'] },
    { hit: ['наследован'], cat: 'oop', add: ['наследование'] },
    { hit: ['абстрактн', 'абстракц'], cat: 'oop', add: ['абстракция'] },
    { hit: ['интерфейс'], cat: 'oop', add: ['интерфейс'] },
    { hit: ['трейт', 'trait'], cat: 'oop', add: ['трейт'] },
    { hit: ['солид', 'solid'], cat: 'solid-patterns', add: ['solid'] },
    { hit: ['паттерн', 'шаблон проектир', 'design pattern'], cat: 'solid-patterns', add: ['паттерн'] },
    { hit: ['замыкан', 'клоужер', 'closure', 'анонимн функц'], cat: 'functions-closures', add: ['замыкание'] },
    { hit: ['генератор', 'generator', 'yield'], cat: 'functions-closures', add: ['генератор'] },
    { hit: ['исключен', 'exception', 'try catch', 'try-catch', 'обработк ошиб'], cat: 'errors-exceptions', add: ['исключение'] },
    { hit: ['массив'], cat: 'arrays-strings', add: ['массив'] },
    { hit: ['строк'], cat: 'arrays-strings', add: ['строка'] },
    { hit: ['spl', 'структур данн'], cat: 'spl-datastructures', add: ['spl'] },
    { hit: ['composer', 'композер', 'автозагруз', 'autoload'], cat: 'namespaces-psr-composer', add: ['composer'] },
    { hit: ['psr'], cat: 'namespaces-psr-composer', add: ['psr'] },
    { hit: ['неймспейс', 'namespace', 'пространств им'], cat: 'namespaces-psr-composer', add: ['namespace'] },
    { hit: ['производительн', 'performance', 'оптимизац', 'opcache', 'опкеш', 'опкэш'], cat: 'performance', add: ['производительность'] },
    { hit: ['безопасн', 'security', 'уязвим'], cat: 'security', add: ['безопасность'] },
    { hit: ['xss'], cat: 'security', add: ['xss'] },
    { hit: ['csrf'], cat: 'security', add: ['csrf'] },
    { hit: ['инъекц', 'injection'], cat: 'security', add: ['инъекция'] },
    { hit: ['jwt', 'джейсон веб токен', 'токен'], cat: 'security', add: ['jwt', 'токен'] },
    { hit: ['oauth', 'оауф'], cat: 'security', add: ['oauth'] },
    { hit: ['хеш', 'хэш', 'hash', 'парол'], cat: 'security', add: ['хеш', 'пароль'] },
    { hit: ['тест', 'phpunit', 'юнит тест', 'мокир', 'mock', 'tdd'], cat: 'testing', add: ['тест'] },
    { hit: ['laravel', 'ларавел', 'ларавель', 'eloquent', 'элоквент'], cat: 'laravel', add: ['laravel'] },
    { hit: ['symfony', 'симфони'], cat: 'symfony-doctrine', add: ['symfony'] },
    { hit: ['doctrine', 'доктрин', 'орм', 'orm', 'объектно реляц'], cat: 'symfony-doctrine', add: ['doctrine', 'orm'] },
    { hit: ['внедрен зависим', 'dependency inject', 'di контейнер', 'ioc', 'сервис контейнер', 'контейнер зависим'], cat: 'symfony-doctrine', add: ['di', 'контейнер'] },
    { hit: ['http', 'хттп'], cat: 'http-rest', add: ['http'] },
    { hit: ['rest', 'рест', 'restful'], cat: 'http-rest', add: ['rest'] },
    { hit: ['api', 'апи'], cat: 'http-rest', add: ['api'] },
    { hit: ['статус код', 'status code', 'код ответа'], cat: 'http-rest', add: ['статус'] },
    { hit: ['cookie', 'куки', 'сесси', 'session'], cat: 'web-general', add: ['сессия', 'cookie'] },
    { hit: ['cors', 'корс'], cat: 'web-general', add: ['cors'] },
    { hit: ['soap', 'соап'], cat: 'integrations', add: ['soap'] },
    { hit: ['grpc', 'джи ар пи си', 'protobuf', 'протобаф', 'протобуф', 'proto файл', 'proto-файл'], cat: 'grpc-protobuf', add: ['grpc', 'protobuf'] },
    { hit: ['вебхук', 'webhook', 'веб хук'], cat: 'integrations', add: ['webhook'] },
    { hit: ['идемпотент'], cat: 'integrations', add: ['идемпотентность'] },
    { hit: ['джойн', 'джоин', 'join'], cat: 'sql-basics', add: ['join'] },
    { hit: ['индекс', 'b-tree', 'btree'], cat: 'db-internals', add: ['индекс'] },
    { hit: ['транзакц', 'transaction', 'acid', 'асид'], cat: 'db-internals', add: ['транзакция'] },
    { hit: ['изоляц', 'isolation'], cat: 'db-internals', add: ['изоляция'] },
    { hit: ['блокировк', 'дедлок', 'deadlock', 'mvcc'], cat: 'db-internals', add: ['блокировка'] },
    { hit: ['postgres', 'постгрес', 'постгре', 'mysql', 'майскл', 'май скл'], cat: 'postgres-mysql', add: ['postgres', 'mysql'] },
    { hit: ['репликац', 'replication', 'шардинг', 'sharding', 'партицион', 'partition'], cat: 'postgres-mysql', add: ['репликация', 'шардинг'] },
    { hit: ['redis', 'редис', 'кеш', 'кэш', 'кеширован', 'кэширован', 'cache'], cat: 'redis-caching', add: ['redis', 'кеш'] },
    { hit: ['очеред', 'queue', 'кафка', 'kafka', 'rabbitmq', 'кролик', 'раббит', 'брокер сообщ', 'message broker'], cat: 'queues-async', add: ['очередь', 'брокер'] },
    { hit: ['асинхрон', 'async', 'воркер', 'worker', 'фонов задач'], cat: 'queues-async', add: ['асинхронность'] },
    { hit: ['финтех', 'fintech', 'платеж', 'payment', 'эквайринг', 'acquiring'], cat: 'fintech', add: ['платеж'] },
    { hit: ['outbox', 'оутбокс', 'аутбокс'], cat: 'fintech', add: ['outbox'] },
    { hit: ['сага ', ' saga'], cat: 'fintech', add: ['сага'] },
    { hit: ['двухфазн', 'two phase', 'two-phase', '2pc'], cat: 'fintech', add: ['двухфазный'] },
    { hit: ['архитектур', 'architecture'], cat: 'architecture', add: ['архитектура'] },
    { hit: ['микросервис', 'microservice'], cat: 'architecture', add: ['микросервис'] },
    { hit: ['монолит', 'monolith'], cat: 'architecture', add: ['монолит'] },
    { hit: ['ддд', ' ddd', 'domain driven', 'доменно ориентир', 'предметн област', 'агрегат', 'aggregate', 'value object', 'bounded context', 'ubiquitous'], cat: 'ddd', add: ['ddd'] },
    { hit: ['cqrs', 'си кью ар эс', 'event sourcing', 'ивент сорсинг', 'event store', 'проекци read', 'read model'], cat: 'cqrs-es', add: ['cqrs', 'event sourcing'] },
    { hit: ['проектир систем', 'system design', 'систем дизайн', 'спроектир', 'масштабир', 'scaling', 'высок нагрузк'], cat: 'sysdesign', add: ['масштабирование'] },
    { hit: ['cap теорем', 'cap-теорем', 'кап теорем'], cat: 'sysdesign', add: ['cap'] },
    { hit: ['балансир', 'load balan'], cat: 'sysdesign', add: ['балансировка'] },
    { hit: ['circuit breaker', 'предохранит', 'рейт лимит', 'rate limit', 'ограничен частот'], cat: 'sysdesign', add: ['rate limit'] },
    { hit: ['observability', 'обсервабилити', 'логирован', 'метрик', 'трейс', 'tracing', 'prometheus', 'прометеус', 'grafana', 'графана'], cat: 'observability', add: ['логи', 'метрики', 'трейсинг'] },
    { hit: ['алгоритм', 'algorithm', 'сложност', 'big o', 'о больш', 'сортировк'], cat: 'algorithms', add: ['алгоритм'] },
    { hit: ['javascript', 'джаваскрипт', 'ивент луп', 'event loop', 'промис', 'promise'], cat: 'javascript', add: ['javascript'] },
    { hit: ['vue', 'вью', 'vuex', 'nuxt', 'накст', 'реактивн'], cat: 'vue-nuxt', add: ['vue'] },
    { hit: ['git ', 'гит ', 'мердж', 'merge', 'ребейз', 'rebase'], cat: 'git-docker-cicd', add: ['git'] },
    { hit: ['docker', 'докер', 'dockerfile', 'контейнеризац'], cat: 'git-docker-cicd', add: ['docker'] },
    { hit: ['ci cd', 'ci/cd', 'сиай', 'пайплайн', 'pipeline', 'непрерывн интеграц'], cat: 'git-docker-cicd', add: ['ci', 'cd'] },
    { hit: ['kubernetes', 'кубернетес', 'кубер', 'k8s', 'деплоймент', 'deployment'], cat: 'kubernetes', add: ['kubernetes'] },
    { hit: ['конкурентн', 'состояние гонки', 'race condition', ' гонк', 'оптимистичн блок', 'пессимистичн блок', 'распределённ лок', 'распределенн лок', 'мьютекс', 'mutex', 'fiber', 'файбер', 'swoole', 'roadrunner'], cat: 'concurrency', add: ['блокировка', 'конкурентность'] },
    { hit: ['graphql', 'граф ку эл', 'графкуэл', 'дата лоадер', 'dataloader', 'резолвер', 'resolver'], cat: 'graphql', add: ['graphql'] },
    { hit: ['elasticsearch', 'эластик', 'эластиксёрч', 'эластиксерч', ' elastic', 'полнотекстов', 'инвертированн индекс', 'bm25'], cat: 'elasticsearch', add: ['elasticsearch'] },
    { hit: ['typescript', 'тайпскрипт', 'тайп скрипт', ' ts ', 'дженерик', 'generic', 'структурн типизац', 'utility type'], cat: 'typescript', add: ['typescript'] },
    { hit: ['linux', 'линукс', ' tcp', ' udp', 'сокет', 'socket', ' dns', 'файлов дескриптор', 'load average', 'iptables', ' ssh', 'рукопожатие tcp'], cat: 'linux-networking', add: ['linux'] },
    { hit: ['python', 'питон', 'пайтон', 'gil', 'джил', 'asyncio', 'асинкио', 'дандер', 'магическ метод', ' pip ', 'виртуальн окружен', 'list comprehension', 'списочн включ', 'lru_cache', 'декоратор python'], cat: 'python', add: ['python'] },
    { hit: ['golang', ' go ', 'горутин', 'goroutine', ' канал', 'channel', 'дефер', 'defer', 'слайс', 'slice', 'go модул', 'го рутин'], cat: 'go', add: ['go', 'golang'] },
    { hit: ['react', 'реакт', 'jsx', 'джиэсэкс', 'хук', ' hook', 'usestate', 'useeffect', 'usememo', 'usecallback', 'виртуальн дом', 'virtual dom', 'реконсиляц', 'reconciliation', 'ререндер', 'ре-рендер'], cat: 'react', add: ['react'] }
  ];

  // по фразе собеседника — карточки. Логика: концепты (буст категории) + оверлап по ключевым словам.
  function suffPick(phrase) {
    var np = engine.norm(' ' + phrase + ' ');
    var words = engine.terms(phrase).filter(function (w) { return w.length >= 2 && !SUFF_STOP[w]; });
    var boostCats = {}, extra = {};
    SUFF_CONCEPTS.forEach(function (c) {
      if (c.hit.some(function (h) { return np.indexOf(h) !== -1; })) {
        boostCats[c.cat] = 1;
        c.add.forEach(function (t) { extra[t] = 1; });
      }
    });
    var termSet = {};
    words.forEach(function (w) { termSet[w] = 1; });
    Object.keys(extra).forEach(function (t) { termSet[t] = 1; });
    var searchTerms = Object.keys(termSet);
    if (!searchTerms.length && !Object.keys(boostCats).length) return { words: [], cards: [] };

    var tally = {};
    searchTerms.forEach(function (w) {
      engine.run(w, '*').slice(0, 30).forEach(function (it, rank) {
        var e = tally[it.id] || (tally[it.id] = { it: it, hits: 0, rankSum: 0, boost: 0 });
        e.hits += 1; e.rankSum += rank;
      });
    });
    // буст карточек названной категории — её топовые (по весу) всплывут, даже если слово не совпало дословно
    Object.keys(boostCats).forEach(function (cat) {
      (SOBES._items || []).forEach(function (it) {
        if (it.cat !== cat) return;
        var e = tally[it.id] || (tally[it.id] = { it: it, hits: 0, rankSum: 60, boost: 0 });
        e.boost += 1;
      });
    });
    var arr = []; for (var k in tally) arr.push(tally[k]);
    arr.sort(function (a, b) {
      var sa = a.hits + a.boost * 1.5, sb = b.hits + b.boost * 1.5; // слово-совпадения + буст категории
      if (sb !== sa) return sb - sa;
      if (a.rankSum !== b.rankSum) return a.rankSum - b.rankSum;
      return (b.it.weight || 0) - (a.it.weight || 0);
    });
    // дедуп по тексту вопроса — один и тот же вопрос из разных категорий не дублируем
    var seenQ = {}, cards = [];
    for (var i = 0; i < arr.length && cards.length < SUFF_N; i++) {
      var qn = engine.norm(arr[i].it.q);
      if (seenQ[qn]) continue;
      seenQ[qn] = 1; cards.push(arr[i].it);
    }
    return { words: searchTerms, cards: cards };
  }

  var suffLastQuery = '';
  // рисует текущие подсказки суфлёра прямо в главный #results (вместо закреплённых)
  function suffShow() {
    els.empty.hidden = true;
    els.results.innerHTML = ''; cardEls = []; state.sel = -1;
    if (!suffLastPhrase) {
      els.counter.textContent = '🎧 Суфлёр слушает…';
      els.results.innerHTML = '<div class="suff-hint">жду вопрос собеседника — или впиши его в поиск сверху</div>';
      return;
    }
    var r = suffPick(suffLastPhrase);
    if (!r.cards.length) {
      els.counter.textContent = '🎧 Суфлёр';
      els.results.innerHTML = '<div class="suff-hint">по этому вопросу карточек не нашлось</div>';
      return;
    }
    els.counter.textContent = '🎧 подсказок: ' + r.cards.length;
    var frag = document.createDocumentFragment();
    r.cards.forEach(function (it) { var el = makeCard(it, r.words, true); cardEls.push(el); frag.appendChild(el); });
    els.results.appendChild(frag);
    if (cardEls[0] && cardEls[0]._more) openDetail(cardEls[0]); // сразу раскрыть верхнюю
    els.results.scrollTop = 0;
  }
  function suffRender(phrase) {
    var p = (phrase || '').trim();
    if (!p || p === suffLastQuery) return;
    suffLastQuery = p; suffLastPhrase = p;
    if (suffMain && !state.query) suffShow(); // при активном поиске суфлёр не перебивает выдачу
  }

  var suffTimer = null;
  function suffSchedule(phrase) {
    if (suffTimer) clearTimeout(suffTimer);
    suffTimer = setTimeout(function () { suffTimer = null; suffRender(phrase); }, 350);
  }

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var suffRec = null, suffStream = null, suffTrack = null, suffOn = false, suffFinal = '';

  function suffSetStatus(txt, cls) { if (!suff.status) return; suff.status.textContent = txt; suff.status.className = 'suff-status' + (cls ? ' ' + cls : ''); }
  function suffShowTrans(interim) {
    suff.trans.innerHTML = escHtml(suffFinal.slice(-400)) + (interim ? ' <i class="suff-interim">' + escHtml(interim) + '</i>' : '');
    suff.trans.scrollTop = suff.trans.scrollHeight;
  }

  function suffStartRec() {
    if (!SR) { suffSetStatus('этот браузер не умеет распознавание речи (нужен Chrome)', 'err'); return; }
    suffRec = new SR();
    suffRec.lang = 'ru-RU'; suffRec.continuous = true; suffRec.interimResults = true;
    suffRec.onresult = function (e) {
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var res = e.results[i];
        if (res.isFinal) { suffFinal += res[0].transcript + ' '; suffSchedule(res[0].transcript); }
        else interim += res[0].transcript;
      }
      suffShowTrans(interim);
      if (interim) suffSchedule(interim);
    };
    suffRec.onerror = function (e) {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      suffSetStatus('ошибка распознавания: ' + e.error, 'err');
    };
    suffRec.onend = function () { if (suffOn && !suffPttOn) { try { suffRec.start(suffTrack); } catch (err) {} } }; // авто-рестарт
    try { suffRec.start(suffTrack); }
    catch (err) { suffSetStatus('этот Chrome не подаёт звук вкладки в распознавание (нужен Chrome 135+)', 'err'); }
  }

  function suffCaptureStop() { // остановить только аудио-захват, режим суфлёра не трогаем
    suffOn = false;
    if (suffRec) { try { suffRec.stop(); } catch (e) {} suffRec = null; }
    if (suffStream) { suffStream.getTracks().forEach(function (t) { t.stop(); }); suffStream = null; }
    suffTrack = null;
  }
  function suffStop() { // полностью выйти из режима суфлёра
    suffCaptureStop();
    suffMain = false;
    if (suff.toggle) suff.toggle.classList.remove('on');
    if (suff.bar) suff.bar.hidden = true;
    els.q.value = ''; state.query = ''; els.clear.hidden = true;
    els.q.setAttribute('placeholder', Q_PLACEHOLDER);
    suffSetStatus('остановлено');
    render(); // вернуть закреплённые / поиск
  }

  function suffEnter() { // включить режим суфлёра на главной, затем попытаться подключить живой звук
    suffMain = true;
    if (suff.toggle) suff.toggle.classList.add('on');
    if (suff.bar) suff.bar.hidden = false;
    els.q.value = ''; state.query = ''; els.clear.hidden = true;
    els.q.setAttribute('placeholder', '🎧 вопрос собеседника — или впиши сам…');
    suffLastQuery = ''; suffLastPhrase = '';
    suffShow();
    suffCapture();
  }
  function suffCapture() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { suffSetStatus('живой захват недоступен — впиши вопрос вручную'); return; }
    suffSetStatus('выбери вкладку со звонком и включи «Поделиться звуком вкладки»…');
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(function (stream) {
      if (!suffMain) { stream.getTracks().forEach(function (t) { t.stop(); }); return; } // успели выключить
      var au = stream.getAudioTracks();
      if (!au.length) { stream.getTracks().forEach(function (t) { t.stop(); }); suffSetStatus('звук вкладки не выбран — можно вписать вручную', 'err'); return; }
      stream.getVideoTracks().forEach(function (t) { t.stop(); }); // видео не нужно
      suffStream = stream; suffTrack = au[0]; suffOn = true;
      suffTrack.onended = function () { suffCaptureStop(); suffSetStatus('захват остановлен — впиши вручную'); };
      suffSetStatus('слушаю собеседника…', 'live');
      suffStartRec();
    }).catch(function (err) {
      suffSetStatus(err && err.name === 'NotAllowedError' ? 'захват отменён — можно вписать вручную' : 'захват не удался — впиши вручную', 'err');
    });
  }

  // ---- push-to-talk: зажать кнопку и сказать СВОИМ голосом (микрофон), что искать ----
  var suffPttRec = null, suffPttOn = false;
  function suffPttMic() {
    if (!suffPttOn || suffPttRec) return;
    suffPttRec = new SR();
    suffPttRec.lang = 'ru-RU'; suffPttRec.continuous = true; suffPttRec.interimResults = true;
    suffPttRec.onresult = function (e) {
      var interim = '', fin = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var res = e.results[i];
        if (res.isFinal) fin += res[0].transcript + ' '; else interim += res[0].transcript;
      }
      if (fin) { suffFinal += fin; suffSchedule(fin); }
      if (interim) suffSchedule(interim);
      if (suff.trans) suff.trans.innerHTML = '🎤 ' + escHtml((suffFinal + interim).slice(-400));
    };
    suffPttRec.onerror = function (e) {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (suff.trans) suff.trans.innerHTML = '<i class="suff-interim">микрофон: ' + escHtml(e.error) + '</i>';
    };
    suffPttRec.onend = function () { if (suffPttOn) { try { suffPttRec.start(); } catch (e) {} } }; // держим живым, пока зажато
    try { suffPttRec.start(); } catch (err) { setTimeout(function () { if (suffPttOn) { try { suffPttRec.start(); } catch (e) {} } }, 200); }
  }
  function suffPttStart() {
    if (!SR || suffPttOn) return;
    suffPttOn = true;
    if (suff.ptt) suff.ptt.classList.add('rec'); // ТОЛЬКО подсветка — статус/текст не трогаем, ничего не съезжает
    suffFinal = '';
    if (suff.trans) suff.trans.innerHTML = '<i class="suff-interim">🎤 говорите…</i>';
    if (suffRec) { // корректно закрыть распознавание собеседника, затем стартовать микрофон (чтобы движок не конфликтовал)
      var prev = suffRec; suffRec = null;
      prev.onend = function () { suffPttMic(); };
      try { prev.stop(); } catch (e) { suffPttMic(); }
      setTimeout(function () { suffPttMic(); }, 250); // страховка, если onend не пришёл (задвоить не даст guard)
    } else {
      suffPttMic();
    }
  }
  function suffPttStop() {
    if (!suffPttOn) return;
    suffPttOn = false;
    if (suff.ptt) suff.ptt.classList.remove('rec');
    if (suffPttRec) { suffPttRec.onend = null; try { suffPttRec.stop(); } catch (e) {} suffPttRec = null; }
    if (suffOn && suffTrack) suffStartRec(); // вернуть распознавание собеседника
  }
  if (suff.ptt) {
    suff.ptt.addEventListener('pointerdown', function (e) { e.preventDefault(); try { suff.ptt.setPointerCapture(e.pointerId); } catch (err) {} suffPttStart(); });
    suff.ptt.addEventListener('pointerup', function () { suffPttStop(); });
    suff.ptt.addEventListener('pointercancel', function () { suffPttStop(); });
    suff.ptt.addEventListener('lostpointercapture', function () { suffPttStop(); });
    suff.ptt.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  if (suff.toggle) suff.toggle.addEventListener('click', function () { if (suffMain) suffStop(); else suffEnter(); });

  window.addEventListener('hashchange', route);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && location.hash) { location.hash = ''; return; }
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
    route();
    els.q.focus();
  }).catch(function (e) {
    els.stat.textContent = 'ошибка загрузки';
    els.empty.hidden = false;
    els.empty.innerHTML = '<b>Не удалось загрузить данные</b><span>' + escHtml(e && e.message || '') + '</span>';
  });
})();
