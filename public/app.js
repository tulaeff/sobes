/* ===== Собес — UI: главная с плитками, суфлёр, мониторинг, запись ===== */
(function () {
  'use strict';
  var api = window.SOBES.api;
  var engine = window.SOBES.search;

  // база карточек нужна суфлёру как справка модели (RAG), сами карточки в UI не показываются
  var ITEMS = [];

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
      if (/^\s*```/.test(ln)) {                       // ограждённый блок кода ```lang … ```
        flushP(); flushL();
        var code = [];
        for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
        html += '<pre class="md-code">' + highlightCode(code.join('\n')) + '</pre>';
      }
      else if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln)) { flushP(); flushL(); html += '<hr>'; }
      else if (/^\s*#{2,4}\s+\S/.test(ln)) {          // «## Заголовок» — им размечен разбор встречи
        flushP(); flushL();
        html += '<h3>' + mdInline(ln.replace(/^\s*#{2,4}\s+/, '')) + '</h3>';
      }
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

  // --- DOM ---
  var els = {
    suffTree: document.getElementById('suff-tree'), suffHint: document.getElementById('suff-hint'),
    counter: document.getElementById('counter'),
    modal: document.getElementById('modal'), modalTitle: document.getElementById('modal-title'),
    modalBody: document.getElementById('modal-body')
  };

  function closeModal() { els.modal.hidden = true; }
  els.modal.addEventListener('click', function (e) { if (e.target.getAttribute('data-close')) closeModal(); });

  // --- мониторинг вакансий: отдельная страница (роут #monitoring) ---
  var monView = document.getElementById('monitoring-view');
  var homeView = document.getElementById('home-view');
  var suffView = document.getElementById('suffler-view');
  var sidebar = document.getElementById('sidebar');
  var sideMon = document.getElementById('sidebar-mon');
  var srcList = document.getElementById('src-list');
  var srcModal = document.getElementById('src-modal');
  var srcFile = document.getElementById('src-file');
  var srcUrl = document.getElementById('src-url');
  var fieldsTg = document.getElementById('src-fields-tg');
  var fieldsAccount = document.getElementById('src-fields-account');
  var srcKind = 'tg';

  // добавление источника — попап, кнопка живёт в сайдбаре мониторинга
  function openSrcAdd() { srcModal.hidden = false; if (srcKind === 'account') srcUrl.focus(); }
  function closeSrcAdd() { srcModal.hidden = true; }
  document.getElementById('src-add-open').addEventListener('click', openSrcAdd);
  srcModal.addEventListener('click', function (e) { if (e.target.getAttribute('data-close')) closeSrcAdd(); });

  var recView = document.getElementById('record-view');
  var sideRec = document.getElementById('sidebar-rec');

  function route() {
    var mon = location.hash === '#monitoring';
    var rec = location.hash === '#record';
    var suf = location.hash === '#suffler';
    if (!suf && suffMain) suffStop(); // ушли со страницы суфлёра — глушим
    homeView.hidden = mon || rec || suf;
    suffView.hidden = !suf;
    monView.hidden = !mon;
    if (recView) recView.hidden = !rec;
    sidebar.hidden = !(mon || rec);   // главная и суфлёр — без сайдбара, во всю ширину
    sideMon.hidden = !mon;
    if (sideRec) sideRec.hidden = !rec;
    if (mon) { loadTgFiles(); loadSources(); loadVacancies(); loadAnalyzeStatus(); }
    if (rec && window.SOBES.recUI) window.SOBES.recUI.open();
  }
  Array.prototype.forEach.call(document.querySelectorAll('#backHome, #backHomeSuff'), function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); location.hash = ''; });
  });

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
  Array.prototype.forEach.call(srcModal.querySelectorAll('.src-tab'), function (tab) {
    tab.addEventListener('click', function () {
      srcKind = tab.getAttribute('data-kind');
      Array.prototype.forEach.call(srcModal.querySelectorAll('.src-tab'), function (t) { t.classList.toggle('active', t === tab); });
      var isAcc = srcKind === 'account';
      fieldsTg.hidden = isAcc; fieldsAccount.hidden = !isAcc;
    });
  });
  document.getElementById('src-add-btn').addEventListener('click', function () {
    var payload;
    if (srcKind === 'account') {
      var url = srcUrl.value.trim();
      if (!url) { srcUrl.focus(); return; }
      payload = { kind: 'account', title: url, value: url };
    } else {
      var file = srcFile.value;
      if (!file) { alert('Нет доступного файла (возможно, все уже добавлены)'); return; }
      payload = { kind: 'tg', title: file, value: file };
    }
    api.addSource(payload).then(function (res) {
      if (res && res.existed) { alert('Такой источник уже добавлен'); return; }
      srcUrl.value = '';
      closeSrcAdd();
      loadSources();
    }).catch(function () { alert('Не удалось добавить источник'); });
  });
  // --- найденные вакансии ---
  var vacList = document.getElementById('vac-list');
  var vacFilter = 'new', allVacs = [], vacPage = 1;
  var VAC_PAGE_SIZE = 20;
  var VAC_FILTERS = [
    { key: 'new',     label: '🆕 Новые',        match: function (v) { return v.applyStatus === 'new'; } },
    { key: 'drafts',  label: '✍️ Черновики',    match: function (v) { return v.applyStatus === 'queued' || v.applyStatus === 'approved'; } },
    { key: 'manual',  label: '✋ Ручной разбор', match: function (v) { return v.applyStatus === 'needs_manual'; } },
    { key: 'applied', label: '✅ Откликнулся',  match: function (v) { return v.applyStatus === 'applied'; } },
    { key: 'direct',  label: '📬 Прямой отклик', match: function (v) { return v.applyStatus === 'direct'; } },
    { key: 'done',    label: '🏁 Завершено',    match: function (v) { return v.applyStatus === 'done'; } }
  ];
  function curFilter() { for (var i = 0; i < VAC_FILTERS.length; i++) if (VAC_FILTERS[i].key === vacFilter) return VAC_FILTERS[i]; return VAC_FILTERS[0]; }
  function statusMatch(v) { return curFilter().match(v); }
  function loadVacancies() {
    if (!vacList) return;
    api.listVacancies().then(function (list) { allVacs = list || []; applyVacFilter(); })
      .catch(function () { vacList.innerHTML = '<div class="src-empty">Ошибка загрузки</div>'; });
  }
  function sortedVacs(list) {
    // в отработанных статусах — последний отклик сверху; иначе как отдаёт API (score desc)
    if (vacFilter === 'applied' || vacFilter === 'direct' || vacFilter === 'done') {
      list = list.slice().sort(function (a, b) {
        return new Date(b.appliedAt || 0) - new Date(a.appliedAt || 0);
      });
    }
    return list;
  }
  function renderVacViews() {
    renderFilters();
    renderVacancies(sortedVacs(allVacs.filter(statusMatch)));
  }
  function applyVacFilter() { // загрузка/обновление — если текущий статус пуст, перейти на первый непустой
    if (!allVacs.filter(statusMatch).length) {
      var fne = VAC_FILTERS.filter(function (f) { return allVacs.filter(f.match).length; })[0];
      if (fne) vacFilter = fne.key;
    }
    renderVacViews();
  }
  function pickStatus(key) { // явный клик по статусу — показываем именно его, даже пустой (не перепрыгиваем)
    vacFilter = key;
    vacPage = 1;
    renderVacViews();
  }
  function renderFilters() { // статус-фильтры (сайдбар); показываем ВСЕ статусы
    var host = document.getElementById('vac-filters'); if (!host) return;
    host.innerHTML = '';
    VAC_FILTERS.forEach(function (f) {
      var n = allVacs.filter(f.match).length;
      var b = document.createElement('button'); b.type = 'button';
      b.className = 'vac-filter' + (vacFilter === f.key ? ' active' : '') + (n ? '' : ' vf-empty');
      var t = document.createElement('span'); t.className = 'vf-name'; t.textContent = f.label;
      var c = document.createElement('span'); c.className = 'vf-count'; c.textContent = n;
      b.appendChild(t); b.appendChild(c);
      b.onclick = function () { pickStatus(f.key); };
      host.appendChild(b);
    });
  }
  var APPLY_BADGE = {
    queued:       ['✍️ черновик готов', 'q'],
    approved:     ['⏳ одобрено', 'a'],
    applied:      ['✅ откликнулся', 'ok'],
    direct:       ['📬 прямой отклик', 'd'],
    done:         ['🏁 завершено', 'f'],
    needs_manual: ['✋ ручной разбор', 'm']
  };
  // все действия карточки — одинаковые кнопки, живут одной строкой в футере
  function vbtn(text, cls, on) {
    var b = document.createElement('button'); b.type = 'button';
    b.className = 'vac-btn' + (cls ? ' ' + cls : ''); b.textContent = text; b.onclick = on; return b;
  }
  function vlink(text, href, title) {
    var a = document.createElement('a'); a.className = 'vac-btn'; a.href = href;
    a.target = '_blank'; a.rel = 'noopener'; a.textContent = text; if (title) a.title = title;
    return a;
  }
  // отказ от вакансии навсегда: уходит из выдачи и больше не всплывёт при следующих сканах
  function skipBtn(v) {
    var b = vbtn('🚫 Пропустить', '', function () { api.skipApply(v.id).then(loadVacancies).catch(loadVacancies); });
    b.title = 'Не откликаться на неё ни сейчас, ни потом — убрать из выдачи навсегда';
    return b;
  }
  // нормализуем контакт из поста в кликабельный href (url / t.me / @username / email); иначе null — покажем текстом
  function applyHref(s) {
    s = (s || '').trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (/^(t\.me|telegram\.me)\//i.test(s)) return 'https://' + s;
    if (/^@[A-Za-z0-9_]{3,}$/.test(s)) return 'https://t.me/' + s.slice(1);
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'mailto:' + s;
    return null;
  }
  // поиск сайта/раздела вакансий компании ВНЕ источника
  function companySearchUrl(v) {
    var q = (v.company || v.title || '').trim();
    return 'https://www.google.com/search?q=' +
      encodeURIComponent(q + ' вакансии карьера официальный сайт -site:hh.ru -site:career.habr.com -site:superjob.ru');
  }
  // найденный контакт нанимающей стороны → кликабельная ссылка (null, если ссылкой не оформить)
  var CONTACT_ICON = { email: '✉️', tg: '✈️', linkedin: 'in', phone: '☎️', site: '🌐', other: '•' };
  function contactHref(c) {
    var val = (c.value || '').trim();
    if (!val) return null;
    if (c.kind === 'email') return 'mailto:' + val;
    if (c.kind === 'phone') return 'tel:' + val.replace(/[^\d+]/g, '');
    if (c.kind === 'tg') {
      if (/^https?:\/\//i.test(val)) return val;
      return 'https://t.me/' + val.replace(/^@/, '');
    }
    return applyHref(val);
  }
  // контакты, до которых удалось докопаться в обход площадки
  function hrContactsBlock(v) {
    var box = document.createElement('div'); box.className = 'vac-apply direct';
    var lbl = document.createElement('div'); lbl.className = 'vac-apply-lbl';
    lbl.textContent = '📬 Прямые контакты (' + v.hrContacts.length + ')';
    box.appendChild(lbl);
    var ul = document.createElement('ul'); ul.className = 'vac-hr';
    v.hrContacts.forEach(function (c) {
      var li = document.createElement('li');
      var ic = document.createElement('span'); ic.className = 'vac-hr-ic'; ic.textContent = CONTACT_ICON[c.kind] || '•';
      li.appendChild(ic);
      var href = contactHref(c);
      if (href) {
        var a = document.createElement('a'); a.className = 'vac-hr-v'; a.href = href;
        a.target = '_blank'; a.rel = 'noopener'; a.textContent = c.value;
        li.appendChild(a);
      } else {
        var s = document.createElement('span'); s.className = 'vac-hr-v'; s.textContent = c.value; li.appendChild(s);
      }
      if (c.name) { var nm = document.createElement('span'); nm.className = 'vac-hr-n'; nm.textContent = c.name; li.appendChild(nm); }
      if (c.note) { var nt = document.createElement('span'); nt.className = 'vac-hr-note'; nt.textContent = c.note; li.appendChild(nt); }
      if (c.source) { var sr = document.createElement('span'); sr.className = 'vac-hr-src'; sr.textContent = 'откуда: ' + c.source; li.appendChild(sr); }
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }
  function applyBadge(v) {
    var b = APPLY_BADGE[v.applyStatus]; if (!b) return null; // 'new' — без бейджа
    var el = document.createElement('span'); el.className = 'vac-badge b-' + b[1]; el.textContent = b[0];
    if (v.applyStatus === 'applied' && v.appliedAt) el.title = 'откликнулся: ' + new Date(v.appliedAt).toLocaleString('ru');
    return el;
  }
  // редактируемый блок сопроводительного письма (переиспользуется в queued и needs_manual);
  // actionRow — строка кнопок статуса, на время правки подменяется на Сохранить/Отмена
  function coverLetterBlock(v, actionRow) {
    var wrap = document.createElement('div');
    var lblRow = document.createElement('div'); lblRow.className = 'vac-apply-lbl-row';
    var lbl = document.createElement('div'); lbl.className = 'vac-apply-lbl';
    lbl.textContent = v.coverLetter ? '✉️ Сопроводительное (черновик)' : '✍️ письмо ещё не сформировано — черновик пустой';
    var editBtn = document.createElement('button'); editBtn.type = 'button'; editBtn.className = 'vac-cover-edit'; editBtn.textContent = '✎ Править';
    lblRow.appendChild(lbl); lblRow.appendChild(editBtn);
    wrap.appendChild(lblRow);
    var pre = document.createElement('pre'); pre.className = 'vac-cover'; pre.textContent = v.coverLetter || '';
    pre.hidden = !v.coverLetter;
    wrap.appendChild(pre);
    editBtn.onclick = function () {
      var ta = document.createElement('textarea'); ta.className = 'vac-cover-input'; ta.value = v.coverLetter || '';
      var saveRow = document.createElement('span'); saveRow.className = 'vac-foot-act';
      var saveBtn = vbtn('💾 Сохранить', 'primary', function () {
        saveBtn.disabled = true;
        api.saveCoverLetter(v.id, ta.value).then(loadVacancies).catch(function () { alert('Не удалось сохранить'); saveBtn.disabled = false; });
      });
      var cancelBtn = vbtn('Отмена', '', function () { loadVacancies(); });
      saveRow.appendChild(saveBtn); saveRow.appendChild(cancelBtn);
      pre.replaceWith(ta);
      actionRow.replaceWith(saveRow);
      editBtn.hidden = true;
      ta.focus();
    };
    return wrap;
  }
  // действия и пояснения по статусу: коробка (черновик письма / заметка) отдельно, кнопки — в футер
  function applyParts(v) {
    var st = v.applyStatus;
    var act = document.createElement('span'); act.className = 'vac-foot-act';
    var box = null;
    if (st === 'queued') {
      box = document.createElement('div'); box.className = 'vac-apply';
      act.appendChild(vbtn('✅ Одобрить отправку', 'primary', function () { api.approveApply(v.id).then(loadVacancies).catch(loadVacancies); }));
      act.appendChild(skipBtn(v));
      box.appendChild(coverLetterBlock(v, act));
    } else if (st === 'needs_manual') {
      box = document.createElement('div'); box.className = 'vac-apply need';
      var n = document.createElement('div'); n.className = 'vac-apply-note'; n.textContent = '✋ Нужна твоя рука: ' + (v.applyNote || 'внешняя форма/тест');
      box.appendChild(n);
      act.appendChild(vbtn('✓ Я откликнулся', 'primary', function () { api.markApplied(v.id).then(loadVacancies).catch(loadVacancies); }));
      act.appendChild(skipBtn(v));
      box.appendChild(coverLetterBlock(v, act));
    } else if (st === 'approved') {
      box = document.createElement('div'); box.className = 'vac-apply wait';
      var w = document.createElement('div'); w.className = 'vac-apply-note'; w.textContent = '⏳ Одобрено — отправлю отклик при следующем прогоне';
      box.appendChild(w);
      act.appendChild(vbtn('✓ Откликнулся', 'primary', function () { api.markApplied(v.id).then(loadVacancies).catch(loadVacancies); }));
      act.appendChild(skipBtn(v));
    } else if (st === 'direct') { // отклик через площадку ушёл, но нашлись живые контакты — пишем мимо неё
      box = hrContactsBlock(v);
      // «Пропустить» здесь не даём: setDupeGroup не трогает direct, кнопка молча ничего бы не делала.
      // Отработал контакты — «Завершить», контакты не годятся — «Убрать» (вернёт в applied)
      act.appendChild(vbtn('🏁 Завершить', 'primary', function () {
        api.markDone(v.id).then(loadVacancies).catch(loadVacancies);
      }));
      act.appendChild(vbtn('✂️ Убрать контакты', '', function () {
        api.saveContacts(v.id, []).then(loadVacancies).catch(loadVacancies);
      }));
    } else if (st === 'new') { // подходящая, ещё без отклика — дать пометить вручную (для тг отклик всегда ручной)
      act.appendChild(vbtn('✓ Откликнулся', 'primary', function () { api.markApplied(v.id).then(loadVacancies).catch(loadVacancies); }));
      act.appendChild(skipBtn(v));
    }
    return { box: box, act: act };
  }
  function renderVacancies(fullList) {
    var cnt = document.getElementById('vac-count');
    if (cnt) cnt.textContent = fullList.length ? '(' + fullList.length + ')' : '';
    vacList.innerHTML = '';
    if (!fullList.length) {
      vacList.innerHTML = '<div class="src-empty">Пока нет подходящих вакансий.</div>';
      renderPager(0, 0);
      return;
    }
    var totalPages = Math.max(1, Math.ceil(fullList.length / VAC_PAGE_SIZE));
    if (vacPage > totalPages) vacPage = totalPages;
    if (vacPage < 1) vacPage = 1;
    var start = (vacPage - 1) * VAC_PAGE_SIZE;
    var list = fullList.slice(start, start + VAC_PAGE_SIZE);
    list.forEach(function (v) {
      var card = document.createElement('article'); card.className = 'vac'; card.id = 'vac-' + v.id;
      var isWeb = v.kind === 'account';
      var head = document.createElement('div'); head.className = 'vac-h';
      var sc = document.createElement('span'); sc.className = 'vac-score' + (v.score >= 85 ? ' hi' : ''); sc.textContent = v.score + '%';
      var tt = document.createElement('div'); tt.className = 'vac-t'; tt.textContent = v.title || '(без названия)';
      var src = document.createElement('span'); src.className = 'vac-source'; src.textContent = (isWeb ? '🌐 ' : '📨 ') + v.chat;
      var del = document.createElement('button'); del.type = 'button'; del.className = 'src-del'; del.textContent = '✕'; del.title = 'Убрать';
      del.onclick = function () { api.deleteVacancy(v.id).then(loadVacancies).catch(loadVacancies); };
      head.appendChild(sc); head.appendChild(tt);
      // работодатель виден на карточке: по нему режется дедуп, иначе две карточки с одним названием неотличимы
      if (v.company) { var co = document.createElement('span'); co.className = 'vac-co'; co.textContent = v.company; head.appendChild(co); }
      var bdg = applyBadge(v); if (bdg) head.appendChild(bdg);
      if (v.applyStatus === 'applied' && v.appliedAt) {
        var ad = document.createElement('span'); ad.className = 'vac-applied-date';
        ad.textContent = new Date(v.appliedAt).toLocaleDateString('ru');
        head.appendChild(ad);
      }
      head.appendChild(src);
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
      var parts = applyParts(v);
      if (parts.box) card.appendChild(parts.box);
      // контакты нашлись, а статус уже другой (например, откликнулся напрямую) — всё равно показываем
      else if (v.hrContacts && v.hrContacts.length) card.appendChild(hrContactsBlock(v));

      // футер: все действия одной строкой, кнопки одного размера
      var foot = document.createElement('div'); foot.className = 'vac-foot';
      var doneWith = v.applyStatus === 'applied' || v.applyStatus === 'direct' || v.applyStatus === 'done';
      if (v.link && !doneWith) { // на уже откликнутых кнопка отклика не нужна
        var href = applyHref(v.link);
        if (href) foot.appendChild(vlink('📩 Откликнуться', href, v.link));
        else { // контакт не оформлен ссылкой (телефон, "писать в ЛС" и т.п.) — показываем текстом
          var ct = document.createElement('span'); ct.className = 'vac-btn plain'; ct.textContent = '📩 ' + v.link; ct.title = v.link;
          foot.appendChild(ct);
        }
      }
      if (v.tgPostUrl) foot.appendChild(vlink('📨 В телеграме', v.tgPostUrl, 'Оригинальный пост (нужно быть в этом канале)'));
      foot.appendChild(vlink(
        v.companyUrl ? '🏢 сайт компании' : '🔎 искать компанию',
        v.companyUrl || companySearchUrl(v),
        v.company ? (v.companyUrl ? 'Открыть: ' + v.company : 'Найти сайт/вакансии: ' + v.company) : 'Поиск по названию вакансии'
      ));
      var textBox = null;
      if (v.text || v.linkText) {
        var moreLbl = isWeb ? 'Описание вакансии' : 'Текст сообщения';
        textBox = document.createElement('div'); textBox.className = 'vac-text hide';
        if (v.text) {
          var l1 = document.createElement('div'); l1.className = 'vac-text-lbl'; l1.textContent = isWeb ? 'Кратко' : 'Пост в телеграме';
          var p1 = document.createElement('pre'); p1.className = 'vac-pre'; p1.textContent = v.text; textBox.appendChild(l1); textBox.appendChild(p1);
        }
        if (v.linkText) {
          var l2 = document.createElement('div'); l2.className = 'vac-text-lbl'; l2.textContent = isWeb ? 'Полное описание' : 'Описание по ссылке';
          var p2 = document.createElement('pre'); p2.className = 'vac-pre'; p2.textContent = v.linkText; textBox.appendChild(l2); textBox.appendChild(p2);
        }
        var more = vbtn(moreLbl, '', function () { var h = textBox.classList.toggle('hide'); more.textContent = h ? moreLbl : 'Скрыть'; });
        foot.appendChild(more);
      }
      foot.appendChild(parts.act);
      card.appendChild(foot);
      if (textBox) card.appendChild(textBox);
      vacList.appendChild(card);
    });
    renderPager(vacPage, totalPages);
  }
  function renderPager(page, totalPages) {
    var host = document.getElementById('vac-pager'); if (!host) return;
    host.innerHTML = '';
    if (totalPages <= 1) return;
    function pbtn(label, targetPage, disabled, active) {
      var b = document.createElement('button'); b.type = 'button';
      b.className = 'pager-btn' + (active ? ' active' : '');
      b.textContent = label; b.disabled = !!disabled;
      b.onclick = function () { vacPage = targetPage; renderVacViews(); vacList.scrollIntoView({ block: 'start' }); };
      return b;
    }
    host.appendChild(pbtn('‹ Назад', page - 1, page <= 1, false));
    // окно страниц вокруг текущей (максимум 7 кнопок с номерами)
    var from = Math.max(1, page - 3), to = Math.min(totalPages, from + 6);
    from = Math.max(1, to - 6);
    if (from > 1) { host.appendChild(pbtn('1', 1, false, page === 1)); if (from > 2) { var d1 = document.createElement('span'); d1.className = 'pager-dots'; d1.textContent = '…'; host.appendChild(d1); } }
    for (var i = from; i <= to; i++) host.appendChild(pbtn(String(i), i, false, i === page));
    if (to < totalPages) { if (to < totalPages - 1) { var d2 = document.createElement('span'); d2.className = 'pager-dots'; d2.textContent = '…'; host.appendChild(d2); } host.appendChild(pbtn(String(totalPages), totalPages, false, page === totalPages)); }
    host.appendChild(pbtn('Вперёд ›', page + 1, page >= totalPages, false));
  }
  function loadAnalyzeStatus() {
    var el = document.getElementById('analyze-status'); if (!el) return;
    api.analyzeStatus().then(function (s) {
      el.textContent = (s && s.last && s.last.at) ? 'последний прогон: ' + new Date(s.last.at).toLocaleString('ru') : '';
    }).catch(function () {});
  }

  // ================= 🎧 Суфлёр: звук вкладки → распознавание → ответы из базы =================
  var suff = {
    toggle: document.getElementById('suff-toggle'),
    bar: document.getElementById('suff-bar'),
    status: document.getElementById('suff-status'),
    trans: document.getElementById('suff-transcript'),
    pause: document.getElementById('suff-pause'),
    reset: document.getElementById('suff-reset'),
    shot: document.getElementById('suff-shot'),
    ask: document.getElementById('suff-ask'),
    logBtn: document.getElementById('suff-log-btn'),
    video: document.getElementById('suff-video'),
    level: document.getElementById('suff-level'),
    levelBar: document.getElementById('suff-level-bar'),
    levelWarn: document.getElementById('suff-level-warn'),
    videoWrap: document.getElementById('suff-video-wrap')
  };

  // ---- лог транскрипта: сырое распознавание + правка до эталона, чтобы мерить будущие улучшения ASR, а не гадать ----
  // Живёт в localStorage (переживает reset/выключение/reload) — сессию записал, потом правишь и выгружаешь .jsonl.
  var SUFF_LOG_KEY = 'sobes:transcript-log';
  var suffLog = [];
  try { var _sl = JSON.parse(localStorage.getItem(SUFF_LOG_KEY) || '[]'); if (Array.isArray(_sl)) suffLog = _sl; } catch (e) {}
  function suffLogSave() { try { localStorage.setItem(SUFF_LOG_KEY, JSON.stringify(suffLog)); } catch (e) {} }
  function suffLogBump() {   // в топбаре — показываем только когда есть что смотреть (переживает выключение суфлёра)
    if (!suff.logBtn) return;
    suff.logBtn.textContent = '📝 транскрипт (' + suffLog.length + ')';
    suff.logBtn.hidden = !suffLog.length;
  }
  function suffLogAdd(raw) {                                    // сырой финал ASR → запись эталона (fix стартует = raw)
    raw = (raw || '').replace(/\s+/g, ' ').trim();
    if (!raw) return;
    suffLog.push({ ts: Date.now(), raw: raw, fix: raw });
    if (suffLog.length > 3000) suffLog.shift();                 // не растим бесконечно
    suffLogSave(); suffLogBump();
  }
  function suffLogStamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }
  function suffLogExport() {                                    // jsonl: строка на реплику, сырое + эталон + время
    if (!suffLog.length) return;
    var t0 = suffLog[0].ts;
    var body = suffLog.map(function (e) {
      return JSON.stringify({ t: e.ts - t0, ts: e.ts, raw: e.raw, corrected: e.fix });
    }).join('\n');
    var url = URL.createObjectURL(new Blob([body], { type: 'application/x-ndjson' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'transcript-' + suffLogStamp() + '.jsonl';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  // модалка: слева сырое распознавание, справа — правишь до эталона; правки сразу в localStorage
  function suffLogOpen() {
    els.modalTitle.textContent = '📝 Транскрипт сессии — эталон для оценки ASR';
    els.modalBody.innerHTML = '';
    var wrap = document.createElement('div'); wrap.className = 'tlog';
    var head = document.createElement('div'); head.className = 'tlog-head';
    var edited = suffLog.filter(function (e) { return e.fix !== e.raw; }).length;
    head.innerHTML =
      '<span class="tlog-count">' + suffLog.length + ' реплик' + (edited ? ' · ' + edited + ' правлено' : '') + '</span>' +
      '<span class="tlog-hint">слева — как распозналось, справа — правь до эталона</span>' +
      '<button type="button" class="btn primary tlog-dl">⬇ Скачать .jsonl</button>' +
      '<button type="button" class="btn tlog-clear">🗑 Очистить</button>';
    wrap.appendChild(head);
    var list = document.createElement('div'); list.className = 'tlog-list';
    if (!suffLog.length) {
      list.innerHTML = '<div class="tlog-empty">пока пусто — включи суфлёр и дай собеседнику говорить, реплики появятся здесь</div>';
    } else {
      suffLog.forEach(function (e, i) {
        var row = document.createElement('div'); row.className = 'tlog-row';
        var raw = document.createElement('div'); raw.className = 'tlog-raw'; raw.textContent = e.raw;
        var inp = document.createElement('textarea'); inp.className = 'tlog-fix'; inp.rows = 2; inp.value = e.fix;
        if (e.fix !== e.raw) inp.classList.add('edited');
        inp.oninput = function () {
          e.fix = inp.value;                    // по объекту записи, не по индексу — иммунно к сдвигу при переполнении
          inp.classList.toggle('edited', inp.value !== e.raw);
          suffLogSave();
        };
        row.appendChild(raw); row.appendChild(inp);
        list.appendChild(row);
      });
    }
    wrap.appendChild(list);
    els.modalBody.appendChild(wrap);
    head.querySelector('.tlog-dl').onclick = suffLogExport;
    head.querySelector('.tlog-clear').onclick = function () {
      if (!suffLog.length) return;
      if (!confirm('Очистить весь записанный транскрипт? Отменить нельзя.')) return;
      suffLog = []; suffLogSave(); suffLogBump(); suffLogOpen();
    };
    els.modal.hidden = false;
    els.modalBody.scrollTop = 0;
  }
  if (suff.logBtn) suff.logBtn.addEventListener('click', suffLogOpen);
  suffLogBump();
  var suffMain = false, suffPaused = false;
  var suffThreads = [];             // темы по порядку (текущая — последняя, снизу); ответы копятся, ничего не пропадает
  var suffAskBuf = '';              // накопитель распознанной речи до ближайшего вопроса
  // стоп-слова + разговорный мусор — чтобы из вопроса вытащить только смысловые термины
  var SUFF_STOP = {};
  ('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по ее мне было вот от меня о из ему когда даже ну ли если уже или ни быть был него до вас уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без чего раз тоже себе под будет тогда кто этот того потому этого какой ним здесь этом один мой тем чтобы нее сейчас были куда зачем всех можно при два об другой хоть после над больше тот через эти нас про всего них какая много три эту моя этой перед лучше чуть том такой им более всегда всю между это твой ваш какие каких нам вообще нужно тебе есть расскажи расскажите опиши опишите объясни объясните скажи давай давайте вопрос например пожалуйста знаешь понимаешь значит типа вот такой так вот ' +
   // каркас вопросов — не смысл, чтобы «что такое X» и «что такое Y» не склеивались в одну тему
   'такое такие таких такого простыми простым простой словами слово слова пример примеры примером разница разницу отличие отличия отличается работает работают работать означает называется называют нужен нужна кстати короче именно скажем допустим представь смотри слушай окей понятно значить почему отчего каким какову')
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

  // концепты + смысловые слова фразы — по ним решаем, продолжение это темы или новый вопрос
  function suffTopicSig(phrase) {
    var np = engine.norm(' ' + phrase + ' ');
    var words = engine.terms(phrase).filter(function (w) { return w.length >= 3 && !SUFF_STOP[w]; });
    var cats = {};
    SUFF_CONCEPTS.forEach(function (c) {
      if (c.hit.some(function (h) { return np.indexOf(h) !== -1; })) cats[c.cat] = 1;
    });
    return { words: words, cats: Object.keys(cats) };
  }
  // маркеры уточнения — «а если…», «почему…», «то есть…» и т.п.
  var SUFF_FOLLOW = ['а ', 'а,', 'то есть', 'почему', 'зачем', 'уточни', 'поясни', 'разверни', 'подробн', 'например', 'а если', 'а что', 'а как', 'а когда', 'а в чём', 'а в чем', 'и ещё', 'и еще'];
  function suffIsClarifier(phrase) {
    var low = (phrase || '').trim().toLowerCase();
    return SUFF_FOLLOW.some(function (m) { return low.indexOf(m) === 0; });
  }
  // Поддакивания собеседника («ага», «понятно», «окей»). Реплика ЦЕЛИКОМ из них не должна плодить тему и жечь воркер.
  // Двусмысленные слова (класс=ООП-класс, так/да/верно/точно — знаменательные) сюда класть можно только для гейта
  // ЦЕЛОЙ реплики, но НЕ для среза с краёв — иначе «что такое класс»→«что такое», «...не так»→«...не».
  var SUFF_BACKCHANNEL = {}, SUFF_PURE_ACK = {};
  // гейт целой реплики: «класс» тут НЕТ (частый ООП-вопрос «что такое класс» терять нельзя)
  ('ага угу мгу гм хм ммм мм эм ну да окей ок оки ясно ясненько понятно понял поняла поняли ' +
   'хорошо ладно так супер отлично здорово именно точно верно логично интересно годится')
    .split(/\s+/).forEach(function (w) { SUFF_BACKCHANNEL[w] = 1; });
  // безопасно срезать с краёв: чистые звуки-квитанции, которые НИКОГДА не несут смысла (без так/да/верно/класс)
  ('ага угу мгу гм хм ммм мм эм ну окей ок оки ясно ясненько понятно понял поняла поняли')
    .split(/\s+/).forEach(function (w) { SUFF_PURE_ACK[w] = 1; });
  function suffTokens(phrase) {
    return (phrase || '').toLowerCase().split(/[\s,.!?;:()"«»\-]+/).filter(Boolean);
  }
  // вся фраза — только поддакивания? (каждый токен в гейт-словаре). «ага» → да; «что такое» → нет (каркас вопроса)
  function suffBackchannelOnly(phrase) {
    var t = suffTokens(phrase);
    return t.length > 0 && t.every(function (w) { return SUFF_BACKCHANNEL[w]; });
  }
  // срезать ведущие/хвостовые ЧИСТЫЕ квитанции: «ага что такое индекс угу» → «что такое индекс».
  // Только SUFF_PURE_ACK — двусмысленные так/да/класс не трогаем, чтобы не съесть смысл.
  function suffStripBackchannel(phrase) {
    var t = suffTokens(phrase);
    var a = 0, b = t.length;
    while (a < b && SUFF_PURE_ACK[t[a]]) a++;
    while (b > a && SUFF_PURE_ACK[t[b - 1]]) b--;
    if (a === 0 && b === t.length) return (phrase || '').trim();   // нечего срезать — не трогаем регистр/пунктуацию
    return t.slice(a, b).join(' ');
  }
  // та же тема? — общий концепт / общее смысловое слово (или его словоформа) / короткое уточнение по горячим следам
  function suffSameTopic(sig, phrase, topic, now) {
    if (now - topic.lastAt > 90000) return false;            // >1.5 мин тишины — считаем новой темой
    if (sig.cats.some(function (c) { return topic.cats[c]; })) return true;
    var wordHit = sig.words.some(function (w) {
      if (topic.words[w]) return true;                       // точное совпадение термина
      if (w.length < 5) return false;
      var pre = w.slice(0, 5);                               // совпадение по префиксу — ловит словоформы (индекс/индексы)
      return Object.keys(topic.words).some(function (k) { return k.length >= 5 && k.slice(0, 5) === pre; });
    });
    if (wordHit) return true;
    if (suffIsClarifier(phrase) && sig.words.length <= 3 && now - topic.lastAt < 50000) return true;
    return false;
  }
  function suffMergeSig(topic, sig) {
    sig.words.forEach(function (w) { topic.words[w] = 1; });
    sig.cats.forEach(function (c) { topic.cats[c] = 1; });
  }
  function suffShort(s) { s = (s || '').trim(); return s.length > 90 ? s.slice(0, 88) + '…' : s; }

  // мутация дерева без дёрганья: если читаешь НЕ у самого верха — компенсируем сдвиг высоты,
  // чтобы твой ответ остался на месте; если ты вверху — показываем новый (свежий сверху)
  function suffMutate(fn) {
    var e = els.suffTree;
    var atTop = e.scrollTop <= 40;
    var oldH = e.scrollHeight;
    fn();
    if (!atTop) e.scrollTop += (e.scrollHeight - oldH);
  }
  // дерево на экране? ушёл на другую страницу — суфлёр ещё живёт, но счётчик трогать нельзя
  function suffViewOn() { return suffMain && location.hash === '#suffler'; }
  // счётчик тем — только когда дерево видно; иначе метим тумблер точкой «пришёл ответ»
  function suffBump() {
    if (suffViewOn()) { els.counter.textContent = '🎧 тем в эфире: ' + suffThreads.length; return; }
    if (suff.toggle) suff.toggle.classList.add('new');
  }
  // снести все ветки (сброс/выключение) — узлы уходят, стримы к ним глохнут по isConnected
  function suffClearTree() {
    suffAbortAll();
    suffThreads = [];
    var tree = els.suffTree;
    while (tree.lastChild) tree.removeChild(tree.lastChild);
    tree.appendChild(els.suffHint);
    els.suffHint.hidden = false;
    tree.scrollTop = 0;
  }
  // первая ветка вытесняет плейсхолдер
  function suffTreeAdd(el) {
    els.suffHint.hidden = true;
    suffMutate(function () { els.suffTree.insertBefore(el, els.suffTree.firstChild); });
  }

  // создать новую тему-ветку СВЕРХУ (свежий ответ — вверху списка)
  function suffCreateTopic(phrase, sig, now) {
    var t = { words: {}, cats: {}, lastAt: now, el: null, answersEl: null, qa: [] };
    suffMergeSig(t, sig);
    var el = document.createElement('div'); el.className = 'suff-topic';
    var head = document.createElement('div'); head.className = 'suff-topic-head';
    head.textContent = '🧵 ' + suffShort(phrase);
    var ans = document.createElement('div'); ans.className = 'suff-topic-answers';
    el.appendChild(head); el.appendChild(ans);
    t.el = el; t.answersEl = ans;
    suffTreeAdd(el);
    suffThreads.unshift(t);
    return t;
  }
  // вернуть тему для фразы: продолжение текущей (верхней) или новая
  function suffRouteTopic(phrase, sig) {
    var now = Date.now();
    var cur = suffThreads[0];
    if (cur && suffSameTopic(sig, phrase, cur, now)) { cur.lastAt = now; suffMergeSig(cur, sig); return cur; }
    return suffCreateTopic(phrase, sig, now);
  }
  // добавить в тему блок «вопрос + место под ответ», вернуть запись (rec.aEl — узел ответа)
  function suffAddQA(topic, phrase) {
    var qa = document.createElement('div');
    qa.className = 'suff-qa' + (topic.answersEl.children.length ? ' suff-followup' : '');
    var q = document.createElement('div'); q.className = 'suff-qa-q'; q.textContent = '🎧 ' + phrase;
    var a = document.createElement('div'); a.className = 'suff-qa-a suff-ai-body';
    a.innerHTML = '<span class="suff-ai-wait">🤖 думаю…</span>';
    qa.appendChild(q); qa.appendChild(a);
    suffMutate(function () { topic.answersEl.appendChild(qa); });   // уточнение — под основным ответом темы
    var rec = { q: phrase, aEl: a, qEl: q, ans: '' };               // qEl — чтобы обновить текст вопроса при supersede
    (topic.qa = topic.qa || []).push(rec);
    return rec;
  }
  // разбить ответ на суть (до первой пустой строки) и остальное (детали/пример → под «подробнее»)
  // Делим ответ на «сказать сейчас» и «подробнее». Маркер %%% ставит сам промпт —
  // делить по пустой строке нельзя: модель ставит её где попало, и под спойлер уезжал почти весь ответ.
  function suffSplitAnswer(text) {
    var t = (text || '').trim();
    var i = t.indexOf('%%%');
    if (i !== -1) return { main: t.slice(0, i).trim(), more: t.slice(i + 3).trim() };
    // маркера нет — либо модель его не поставила, либо он ещё не достримился
    var tail = t.match(/%{1,2}$/);                 // «%» или «%%» на конце — начало маркера, не показываем
    if (tail) t = t.slice(0, -tail[0].length).trim();
    return { main: t, more: '' };
  }
  function suffMoreBlock(text) {
    var wrap = document.createElement('div'); wrap.className = 'suff-more';
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'suff-more-btn'; btn.textContent = 'Подробнее ▾';
    var c = document.createElement('div'); c.className = 'suff-more-body suff-ai-body'; c.hidden = true; c.innerHTML = mdBlock(text);
    btn.onclick = function () { c.hidden = !c.hidden; btn.textContent = c.hidden ? 'Подробнее ▾' : 'Свернуть ▴'; };
    wrap.appendChild(btn); wrap.appendChild(c);
    return wrap;
  }
  // история темы (завершённые пары вопрос-ответ) → контекст для уточнений
  function suffTopicHistory(topic) {
    var h = [];
    (topic.qa || []).slice(-3).forEach(function (it) {
      var a = suffSplitAnswer(it.ans || '').main;   // в контекст — только суть: детали под спойлером модели не нужны
      if (it.q && a && a.length > 8) h.push({ q: it.q, a: a });
    });
    return h;
  }
  // показать накопленное дерево (ветки при этом не трогаем)
  function suffShow() {
    els.suffHint.hidden = suffThreads.length > 0;
    if (suff.toggle) suff.toggle.classList.remove('new');
    els.counter.textContent = suffThreads.length
      ? '🎧 тем в эфире: ' + suffThreads.length
      : '🎧 Суфлёр слушает…';
  }

  // карточки под вопрос — как справка модели. Ничего не нашлось → пустой массив, ИИ отвечает сам
  function suffCards(phrase) {
    if (!engine.retrieve) return [];
    var found;
    try { found = engine.retrieve(phrase, 3); } catch (e) { return []; }
    return (found || []).map(function (it, i) {
      var c = { q: it.q, a: cut(it.a, 700) };
      if (i === 0 && it.detail) c.detail = cut(it.detail, 600);   // подробности только у самой близкой
      return c;
    });
  }
  function cut(s, n) { s = (s || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }

  // Кольцо недавних вопросов: дубль отсекаем, но через полминуты тот же вопрос спросить можно —
  // интервьюер вполне может вернуться к теме или попросить повторить.
  var suffRecent = [];
  var SUFF_DUP_WINDOW = 40000;
  function suffAskedRecently(pn) {
    var now = Date.now();
    suffRecent = suffRecent.filter(function (r) { return now - r.t < SUFF_DUP_WINDOW; });
    for (var i = 0; i < suffRecent.length; i++) {
      if (engine.similar(suffRecent[i].pn, pn)) { suffRecent[i].t = now; return true; }
    }
    suffRecent.push({ pn: pn, t: now });
    if (suffRecent.length > 8) suffRecent.shift();
    return false;
  }

  // дедлайны сами пишут человеческий текст (число секунд там же, где константа) — тут только техническое
  var SUFF_ERR = { http: 'сервер вернул ошибку', network: 'сеть отвалилась' };
  // сбой прямо в узле ответа: недостримленный кусок сохраняем, рядом — кнопка повтора
  function suffFail(rec, acc, err) {
    var body = rec.aEl;
    body.innerHTML = '';
    if (acc) {
      var parts = suffSplitAnswer(acc);
      var part = document.createElement('div'); part.innerHTML = mdBlock(parts.main); body.appendChild(part);
      if (parts.more) part.appendChild(suffMoreBlock(parts.more));   // успело дойти до деталей — не выбрасываем
    }
    var kind = (err && err.kind) || 'network';
    var msg = document.createElement('div'); msg.className = 'suff-ai-err';
    msg.textContent = '⚠ ' + (SUFF_ERR[kind] ? SUFF_ERR[kind] + ' · ' + ((err && err.message) || '?') : (err && err.message) || 'обрыв');
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'suff-retry';
    btn.textContent = '↻ спросить ещё раз';
    btn.onclick = function () { suffRun(rec); };
    body.appendChild(msg); body.appendChild(btn);
  }
  // один прогон стрима в готовый узел: отмена своим контроллером, дедлайны внутри api.js
  function suffRun(rec) {
    var body = rec.aEl, acc = '';
    if (rec.ctrl) { try { rec.ctrl.abort(); } catch (e) {} }
    var ctrl = new AbortController();
    rec.ctrl = ctrl; rec.ans = '';
    // через suffMutate: на повторе узел схлопывается с высокого (ответ+ошибка+кнопка) до спиннера — компенсируем скролл
    suffMutate(function () { body.innerHTML = '<span class="suff-ai-wait">' + (rec.wait || '🤖 думаю…') + '</span>'; });

    // рендерим mdBlock прямо на стриме (а не сырой textContent), чтобы суть сразу была <p> и не скакала
    // 17→20px на завершении, а буллеты были списком, а не «- ». Троттлинг по rAF: пачка чанков в кадре → один
    // рендер, без повторных reflow (scrollHeight в suffMutate) — это и убирает дёрганье.
    var raf = 0;
    function paint() {
      raf = 0;
      if (!body.isConnected) return;
      var main = suffSplitAnswer(acc).main;
      if (!main) return;                                 // сути ещё нет — держим спиннер, не мигаем
      suffMutate(function () { body.innerHTML = mdBlock(main); });
    }
    function stopRaf() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

    rec.start(function (chunk) {
      if (!body.isConnected) { ctrl.abort(); return; }   // ветку снесли — рвём запрос, а не держим воркер до конца
      acc += chunk;
      rec.ans = acc;   // пишем на каждом чанке: уточнение часто прилетает ДО конца ответа и должно видеть контекст
      if (!raf) raf = requestAnimationFrame(paint);      // не чаще кадра
    }, ctrl.signal).then(function () {
      if (rec.ctrl === ctrl) rec.ctrl = null;   // не затираем более новый ctrl (supersede/повтор уже перезапустили стрим)
      stopRaf();
      if (rec.ctrl !== null || !body.isConnected) return;   // узел перезапущен новым прогоном — этот результат уже неактуален
      var parts = suffSplitAnswer(acc);
      suffMutate(function () {
        body.innerHTML = parts.main ? mdBlock(parts.main) : (acc ? mdBlock(acc) : '<span class="suff-ai-err">пустой ответ</span>');
        if (parts.more) body.appendChild(suffMoreBlock(parts.more));  // детали/пример — под «подробнее»
      });
    }).catch(function (e) {
      var mine = rec.ctrl === ctrl;
      if (mine) rec.ctrl = null;
      stopRaf();
      if (!mine || !body.isConnected || (e && e.kind === 'aborted')) return;   // не мой прогон / сброс / выключение — молча
      suffMutate(function () { suffFail(rec, acc, e); });
    });
  }
  // оборвать все висящие запросы (сброс/выключение) — иначе воркеры php-fpm держатся до конца стрима
  function suffAbortAll() {
    suffThreads.forEach(function (t) {
      (t.qa || []).forEach(function (r) { if (r.ctrl) { try { r.ctrl.abort(); } catch (e) {} r.ctrl = null; } });
    });
  }

  // ---- AI-суфлёр: вопрос собеседника → ответ Claude (карточки подмешиваются, если нашлись) ----
  function suffAsk(phrase) {
    var p = (phrase || '').replace(/\s+/g, ' ').trim();
    if (!suffMain || p.length < 3) return null;    // «ООП?», «CAP?», «GIL?» — короткие, но настоящие вопросы
    var pn = engine.norm(p);
    if (!pn || suffAskedRecently(pn)) return null; // распознавание любит повторить фразу с мелкой разницей
    var sig = suffTopicSig(p);
    var topic = suffRouteTopic(p, sig);
    var history = suffTopicHistory(topic);         // контекст темы собираем ДО добавления текущего вопроса
    var rec = suffAddQA(topic, p);
    rec.cards = suffCards(p);      // справка из базы (пусто = ИИ отвечает сам); history — контекст уточнений
    rec.history = history;
    rec.start = function (onChunk, signal) { return api.askStream(rec.q, rec.cards, onChunk, rec.history, signal); };
    suffBump();
    suffRun(rec);
    return rec;                    // вернём rec — нужен спекуляции по interim (supersede при расхождении с финалом)
  }

  // ---- разбор скрина: снять кадр правой панели (видео вкладки) и отправить в Claude vision ----
  // блок скрина — отдельная ветка сверху, помечена «протухшим» временем, чтобы речь к ней не липла
  function suffAddShot(dataUrl) {
    var t = { words: {}, cats: {}, lastAt: Date.now() - 999999, el: null, answersEl: null, qa: [] };
    var el = document.createElement('div'); el.className = 'suff-topic';
    var head = document.createElement('div'); head.className = 'suff-topic-head'; head.textContent = '🖼 Разбор скрина';
    var ans = document.createElement('div'); ans.className = 'suff-topic-answers';
    el.appendChild(head); el.appendChild(ans);
    t.el = el; t.answersEl = ans;
    suffTreeAdd(el);
    suffThreads.unshift(t);
    var qa = document.createElement('div'); qa.className = 'suff-qa';
    var img = document.createElement('img'); img.className = 'suff-shot-img'; img.src = dataUrl; img.alt = 'скрин вкладки';
    var a = document.createElement('div'); a.className = 'suff-qa-a suff-ai-body';
    a.innerHTML = '<span class="suff-ai-wait">🤖 смотрю на скрин…</span>';
    qa.appendChild(img); qa.appendChild(a);
    suffMutate(function () { ans.appendChild(qa); });
    suffBump();
    var rec = { q: '🖼 скрин', aEl: a, ans: '', wait: '🤖 смотрю на скрин…' };
    t.qa.push(rec);
    return rec;
  }
  function suffAskShot() {
    if (!suffMain) return;
    var vid = suff.video;
    if (!vid || !vid.srcObject || !vid.videoWidth) { suffSetStatus('нет видео вкладки — включи захват с картинкой', 'err'); return; }
    var vw = vid.videoWidth, vh = vid.videoHeight, scale = Math.min(1, 1280 / vw); // ужимаем до 1280 по ширине
    var cw = Math.round(vw * scale), ch = Math.round(vh * scale);
    var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    cv.getContext('2d').drawImage(vid, 0, 0, cw, ch);
    var dataUrl = cv.toDataURL('image/jpeg', 0.85);
    var rec = suffAddShot(dataUrl);
    rec.start = function (onChunk, signal) { return api.visionStream(dataUrl, onChunk, signal); };
    suffRun(rec);
  }

  // накапливаем распознанную речь и спрашиваем ИИ, когда фраза «устоялась» (пауза)
  var suffAskTimer = null, suffBufSince = 0;
  var SUFF_DEBOUNCE = 1200;    // пауза, после которой фраза считается «устоявшейся»
  var SUFF_QUICK = 700;        // уже виден готовый вопрос — тянуть незачем
  var SUFF_MAXWAIT = 6000;     // потолок: длинный монолог без пауз всё равно уходит запросом

  // Коррекция сырого распознавания картой поломок из /api/asr-terms (кириллические манглы → канон: «кофта»→Kafka).
  // Правит фразу ПЕРЕД маршрутизацией темы и RAG — иначе «кофта» не находит карточки Kafka. Сырое в транскрипте нетронуто.
  // Модель и без этого чинит термины через ASR_HINT; здесь важна именно правка ДЛЯ retrieval/routing на клиенте.
  var suffFixRules = [], suffFixLoaded = false, suffFixLoading = false;
  function suffLoadFixes() {
    if (suffFixLoaded || suffFixLoading) return;   // уже загружено или уже в полёте — не дублируем запрос
    suffFixLoading = true;
    api.asrTerms().then(function (d) {
      var fixes = (d && d.fixes) || {};
      Object.keys(fixes).sort(function (a, b) { return b.length - a.length; }).forEach(function (k) {  // длинные ключи первыми
        var re = new RegExp('(^|[^0-9a-zа-яё])' + engine.escRe(k) + '(?![0-9a-zа-яё])', 'gi');           // по границам слова
        suffFixRules.push({ re: re, to: fixes[k] });
      });
      suffFixLoaded = true; suffFixLoading = false;   // флаг — только на успехе
    }).catch(function () { suffFixLoading = false; });  // сбой → флаг сброшен, следующий suffEnter повторит (модель всё равно чинит через ASR_HINT)
  }
  function suffFixTerms(text) {
    if (!text || !suffFixRules.length) return text;
    var out = text;
    for (var i = 0; i < suffFixRules.length; i++) {
      out = out.replace(suffFixRules[i].re, (function (r) { return function (m, pre) { return pre + r.to; }; })(suffFixRules[i]));
    }
    return out;
  }

  // фраза уже выглядит как законченный вопрос? (концепт или ≥2 смысловых слова + приличная длина)
  function suffLooksComplete(phrase) {
    if (!phrase || phrase.length < 18) return false;
    var sig = suffTopicSig(phrase);
    return !!(sig.cats.length || sig.words.length >= 2);
  }

  // ---- Спекулятивный запрос по interim: стреляем ДО финала, пока собеседник договаривает ----
  // Web Speech отдаёт финал с задержкой, а промежуточный результат уже готов. Если interim выглядит законченным
  // вопросом и «устоялся» (не меняется ~450мс) — спрашиваем сразу. На финале сверяем: совпал → ответ уже стримится
  // (сэкономили паузу+дебаунс), разошёлся → заменяем вопрос корректным В ТОМ ЖЕ узле (suffSupersede).
  var SUFF_SPEC_STABLE = 450;
  var suffSpec = null;                 // {rec, text, at} — спекуляция текущей реплики (одна на реплику)
  var suffSpecTimer = null, suffInterimText = '';
  function suffSpecDrop() {            // бросить спекуляцию, ОБОРВАВ её висящий стрим — иначе осиротевший держит воркер
    if (suffSpec && suffSpec.rec && suffSpec.rec.ctrl) { try { suffSpec.rec.ctrl.abort(); } catch (e) {} }
    suffSpec = null;
  }
  function suffSpecClear() {           // сброс спекуляции + таймера стабильности (реплика закрыта / стоп)
    if (suffSpecTimer) { clearTimeout(suffSpecTimer); suffSpecTimer = null; }
    suffSpecDrop(); suffInterimText = '';
  }
  function suffSpecScan(interim) {      // interim обновился → перезапускаем окно стабильности
    if (!suffMain || suffPaused) return;
    var t = (interim || '').replace(/\s+/g, ' ').trim();
    if (!t || t === suffInterimText) return;
    suffInterimText = t;
    if (suffSpecTimer) clearTimeout(suffSpecTimer);
    suffSpecTimer = setTimeout(function () { suffSpecTimer = null; suffSpeculate(suffInterimText); }, SUFF_SPEC_STABLE);
  }
  function suffSpeculate(interim) {
    if (!suffMain || suffPaused) return;
    if (suffSpec && Date.now() - suffSpec.at > 8000) suffSpecDrop();   // прошлая спекуляция протухла (финал не пришёл) — оборвать
    if (suffSpec) return;                                                // одна спекуляция на реплику
    var cand = suffFixTerms(suffStripBackchannel(interim));
    if (!cand || suffBackchannelOnly(cand) || !suffLooksComplete(cand)) return;   // не законченный вопрос — ждём финал
    var rec = suffAsk(cand);                                             // suffAsk сам дедупит и возвращает rec (или null)
    if (rec) suffSpec = { rec: rec, text: cand, at: Date.now() };
  }
  // заменить спекулятивный вопрос корректным финальным В ТОМ ЖЕ узле (без нового блока)
  function suffSupersede(rec, phrase) {
    var pn = engine.norm(phrase);
    if (!pn) return;
    suffAskedRecently(pn);                                // застолбить, чтобы дубль финала не переспросил
    rec.q = phrase;
    if (rec.qEl) rec.qEl.textContent = '🎧 ' + phrase;
    rec.cards = suffCards(phrase);
    rec.start = function (onChunk, signal) { return api.askStream(rec.q, rec.cards, onChunk, rec.history, signal); };
    suffRun(rec);                                         // перезапуск стрима в том же узле (старый ctrl абортится внутри)
  }

  function suffAskFire() {
    if (suffAskTimer) { clearTimeout(suffAskTimer); suffAskTimer = null; }
    var phrase = suffFixTerms(suffStripBackchannel(suffAskBuf.replace(/\s+/g, ' ').trim()));
    suffAskBuf = ''; suffBufSince = 0;
    if (suffSpecTimer) { clearTimeout(suffSpecTimer); suffSpecTimer = null; }   // финал пришёл — окно стабильности не нужно
    suffInterimText = '';                                 // новая реплика начнёт стабильность с чистого листа
    if (suffSpec && Date.now() - suffSpec.at > 8000) suffSpecDrop();   // несвежая спекуляция (её финал дропнули) — не наш узел, оборвать
    if (!phrase) { suffSpecClear(); return; }
    if (suffSpec) {                                        // была спекуляция по interim — сверяем с финалом
      var spec = suffSpec; suffSpec = null;
      if (engine.similar(engine.norm(spec.text), engine.norm(phrase))) return;  // совпало → ответ уже стримится
      suffSupersede(spec.rec, phrase);                     // разошлось → заменяем в том же узле
      return;
    }
    suffAsk(phrase);   // коррекция терминов уже применена; сырое ушло в транскрипт отдельно
  }
  // накопитель речи → вопрос: гейт бэкчэннела + умный дебаунс + потолок ожидания
  function suffAskSchedule() {
    var phrase = suffAskBuf.replace(/\s+/g, ' ').trim();
    if (suffBackchannelOnly(phrase)) {                       // одни поддакивания — не вопрос, копить нечего
      if (suffAskTimer) { clearTimeout(suffAskTimer); suffAskTimer = null; }
      suffAskBuf = ''; suffBufSince = 0;
      return;
    }
    if (suffBufSince && Date.now() - suffBufSince >= SUFF_MAXWAIT) { suffAskFire(); return; }  // монолог не тянем
    if (suffAskTimer) clearTimeout(suffAskTimer);
    suffAskTimer = setTimeout(suffAskFire, suffPickWait(phrase));
  }
  // задержка дебаунса: готовый вопрос (концепт или ≥2 смысловых слова, длина приличная) — режем короче, иначе ждём паузу
  function suffPickWait(phrase) {
    return suffLooksComplete(phrase) ? SUFF_QUICK : SUFF_DEBOUNCE;   // готовый вопрос — режем короче
  }

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var suffRec = null, suffStream = null, suffTrack = null, suffOn = false, suffFinal = '';

  function suffSetStatus(txt, cls) { if (!suff.status) return; suff.status.textContent = txt; suff.status.className = 'suff-status' + (cls ? ' ' + cls : ''); }

  // ---- полоска громкости вкладки ----
  // Раньше молчащий суфлёр было не отличить от «собеседник просто не говорит»: если звук вкладки
  // не подключился, статус всё равно бодро писал «слушаю». Теперь громкость видно, а полную тишину
  // в первые полминуты после старта называем вслух — почти всегда это забытая галочка в окне захвата.
  var suffMeterCtx = null, suffMeterTimer = null, suffMeterFn = null, suffLoudAt = 0, suffHeard = false;
  var SUFF_QUIET_RMS = 0.0004, SUFF_QUIET_WARN_MS = 25000;
  function suffMeterStop() {
    if (suffMeterTimer) { clearInterval(suffMeterTimer); suffMeterTimer = null; }
    if (suffMeterCtx) { try { suffMeterCtx.close(); } catch (e) {} suffMeterCtx = null; }
    suffMeterFn = null;
    if (suff.levelBar) suff.levelBar.style.width = '0%';
    if (suff.level) suff.level.hidden = true;
    if (suff.levelWarn) suff.levelWarn.hidden = true;
  }
  function suffMeterStart(stream) {
    suffMeterStop();
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      suffMeterCtx = new Ctx();
      var an = suffMeterCtx.createAnalyser();
      an.fftSize = 1024;
      suffMeterCtx.createMediaStreamSource(stream).connect(an);
      var buf = new Float32Array(an.fftSize);
      suffMeterFn = function () {
        an.getFloatTimeDomainData(buf);
        var acc = 0;
        for (var i = 0; i < buf.length; i++) acc += buf[i] * buf[i];
        return Math.sqrt(acc / buf.length);
      };
    } catch (e) { return; }
    suffLoudAt = Date.now(); suffHeard = false;
    if (suff.level) suff.level.hidden = false;
    if (suff.levelWarn) suff.levelWarn.hidden = true;
    suffMeterTimer = setInterval(function () {
      if (!suffMeterFn) return;
      var rms = suffMeterFn();
      if (suff.levelBar) suff.levelBar.style.width = Math.min(100, Math.round(Math.sqrt(rms) * 350)) + '%';
      if (rms >= SUFF_QUIET_RMS) {
        suffHeard = true;
        if (suff.levelWarn) suff.levelWarn.hidden = true;
        return;
      }
      // статус тут не годится: на тишине Chrome перезапускает распознавание, и onstart затирает любое сообщение
      if (!suffHeard && suff.levelWarn && Date.now() - suffLoudAt > SUFF_QUIET_WARN_MS) suff.levelWarn.hidden = false;
    }, 150);
  }
  function suffShowTrans(interim) {
    suff.trans.innerHTML = escHtml(suffFinal.slice(-400)) + (interim ? ' <i class="suff-interim">' + escHtml(interim) + '</i>' : '');
    suff.trans.scrollTop = suff.trans.scrollHeight;
  }

  // Распознавание Chrome обрывается само (тишина, сеть, внутренние лимиты) — его надо поднимать.
  // Раньше рестарт был через пустой catch: объект умирал молча, а статус продолжал показывать «слушаю».
  var suffRecAlive = false, suffRecFails = 0, suffRestartTimer = null, suffWatchTimer = null, suffLastEventAt = 0;
  var SUFF_BACKOFF = [0, 300, 800, 2000, 5000];

  function suffRestartRec(why) {
    if (!suffOn || suffPaused || suffRestartTimer) return;
    var wait = SUFF_BACKOFF[Math.min(suffRecFails, SUFF_BACKOFF.length - 1)];
    if (suffRecFails >= 6) {
      suffSetStatus('распознавание не поднимается — впиши вопрос вручную', 'err');
      return;
    }
    if (suffRecFails > 0) suffSetStatus('распознавание сорвалось (' + why + '), поднимаю…', 'err');
    suffRestartTimer = setTimeout(function () {
      suffRestartTimer = null;
      if (suffOn && !suffPaused) suffStartRec();
    }, wait);
  }

  function suffStopRec() {
    if (suffRestartTimer) { clearTimeout(suffRestartTimer); suffRestartTimer = null; }
    if (suffWatchTimer) { clearInterval(suffWatchTimer); suffWatchTimer = null; }
    suffSpecClear();   // распознавание встало — незакрытую спекуляцию по interim бросаем
    suffRecAlive = false;
    if (suffRec) { suffRec.onend = null; try { suffRec.stop(); } catch (e) {} suffRec = null; }
  }

  function suffStartRec() {
    if (!SR) { suffSetStatus('этот браузер не умеет распознавание речи (нужен Chrome)', 'err'); return; }
    if (suffRec) { suffRec.onend = null; try { suffRec.stop(); } catch (e) {} }   // старый объект не должен дёргать рестарт
    suffRec = new SR();
    suffRec.lang = 'ru-RU'; suffRec.continuous = true; suffRec.interimResults = true;
    var startedAt = Date.now();
    suffLastEventAt = startedAt;

    suffRec.onstart = function () {            // статус только по факту старта, а не авансом
      suffRecAlive = true; suffRecFails = 0; suffLastEventAt = Date.now();
      suffSetStatus('слушаю собеседника…', 'live');
    };
    suffRec.onaudiostart = function () { suffLastEventAt = Date.now(); };
    suffRec.onresult = function (e) {
      suffLastEventAt = Date.now();
      var interim = '', fin = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var res = e.results[i];
        if (res.isFinal) fin += res[0].transcript + ' '; else interim += res[0].transcript;
      }
      if (fin) {                                    // финал → в накопитель + дебаунс вопроса
        suffFinal += fin;
        suffLogAdd(fin);                            // сырой финал → лог транскрипта (эталон для оценки ASR)
        if (suffAskBuf === '') suffBufSince = Date.now();   // старт окна накопления — для потолка ожидания
        suffAskBuf += fin;
        suffAskSchedule();
      }
      suffShowTrans(interim);
      if (interim) suffSpecScan(interim);   // промежуточный результат → может стрельнуть спекулятивно ДО финала
    };
    suffRec.onerror = function (e) {
      if (e.error === 'no-speech' || e.error === 'aborted') return;   // штатные обрывы, поднимет onend
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        suffRecFails = 99;                                            // разрешение отозвали — рестартить бессмысленно
        suffSetStatus('доступ к распознаванию закрыт — впиши вопрос вручную', 'err');
        return;
      }
      suffSetStatus('ошибка распознавания: ' + e.error, 'err');
    };
    suffRec.onend = function () {
      suffRecAlive = false;
      // сорвалось сразу после старта — считаем неудачей и разводим попытки во времени
      if (Date.now() - startedAt < 1000) suffRecFails++; else suffRecFails = 0;
      suffRestartRec('обрыв');
    };

    try {
      suffRec.start(suffTrack);
      suffSetStatus('подключаюсь к звуку вкладки…');
    } catch (err) {
      suffRecAlive = false; suffRecFails++;
      if (suffRecFails === 1) suffSetStatus('этот Chrome не подаёт звук вкладки в распознавание (нужен Chrome 135+)', 'err');
      suffRestartRec('start не прошёл');
      return;
    }

    if (!suffWatchTimer) {
      suffWatchTimer = setInterval(function () {
        if (!suffOn || suffPaused) return;
        // объект жив, но событий нет минуту — Chrome иногда «залипает» без onend; пересоздаём
        if (suffRecAlive && Date.now() - suffLastEventAt > 60000) { suffRecFails = 0; suffStartRec(); return; }
        // объект мёртв, а рестарт не запланирован — значит onend не пришёл вовсе
        if (!suffRecAlive && !suffRestartTimer) suffRestartRec('тишина');
      }, 5000);
    }
  }

  function suffHideVideo() {
    if (suff.video) { try { suff.video.pause(); } catch (e) {} suff.video.srcObject = null; }
    if (suff.videoWrap) suff.videoWrap.hidden = true;
  }
  function suffCaptureStop() { // остановить только захват (аудио+видео), режим суфлёра не трогаем
    suffOn = false;
    suffStopRec();
    suffMeterStop();
    if (suffStream) { suffStream.getTracks().forEach(function (t) { t.stop(); }); suffStream = null; }
    suffTrack = null;
    suffHideVideo();
  }
  // ---- пауза: перестать слушать, но остаться в режиме (звук/видео вкладки живы, продолжить мгновенно) ----
  function suffUpdatePauseBtn() {
    if (!suff.pause) return;
    suff.pause.textContent = suffPaused ? '▶ продолжить' : '⏸ пауза';
    suff.pause.classList.toggle('paused', suffPaused);
  }
  function suffPauseToggle() {
    if (!suffMain) return;
    if (suffPaused) {                       // продолжить
      suffPaused = false; suffUpdatePauseBtn();
      if (suffTrack) { suffRecFails = 0; suffStartRec(); }
      else suffCapture();
    } else {                                // пауза
      suffPaused = true; suffUpdatePauseBtn();
      if (suffAskTimer) { clearTimeout(suffAskTimer); suffAskTimer = null; }
      suffAskBuf = ''; suffBufSince = 0;
      suffStopRec();
      suffSetStatus('пауза — не слушаю');
    }
  }
  // сброс: очистить все ответы и контекст тем, НЕ выключая суфлёр (жать между вопросами)
  function suffReset() {
    if (!suffMain) return;
    if (suffAskTimer) { clearTimeout(suffAskTimer); suffAskTimer = null; }
    // «чистый лист»: и контент, и контекст для ИИ (history строится из topic.qa — уходит вместе с темами)
    suffClearTree(); suffAskBuf = ''; suffBufSince = 0; suffRecent = []; suffSpecClear();
    suffFinal = '';                                   // и видимый транскрипт тоже
    if (suff.trans) suff.trans.innerHTML = '';
    suffShow();   // тем нет → плейсхолдер, чистый экран под новый вопрос
  }
  function suffStop() { // полностью выйти из режима суфлёра
    suffCaptureStop();
    suffMain = false; suffPaused = false; suffUpdatePauseBtn();
    if (suffAskTimer) { clearTimeout(suffAskTimer); suffAskTimer = null; }
    suffClearTree(); suffAskBuf = ''; suffBufSince = 0; suffRecent = []; suffSpecClear();
    if (suff.toggle) { suff.toggle.classList.remove('on'); suff.toggle.classList.remove('new'); suff.toggle.textContent = '🎧 Включить'; }
    document.getElementById('app').classList.remove('suff-live');
    if (suff.bar) suff.bar.hidden = true;
    if (suff.ask) suff.ask.value = '';
    suffSetStatus('остановлено');
    els.counter.textContent = '';
  }

  function suffEnter() { // включить режим суфлёра, затем попытаться подключить живой звук
    suffLoadFixes();   // подтягиваем карту поломок ASR (лениво, один раз)
    suffMain = true; suffPaused = false; suffUpdatePauseBtn();
    if (suff.toggle) { suff.toggle.classList.add('on'); suff.toggle.textContent = '⏹ Выключить'; }
    document.getElementById('app').classList.add('suff-live');   // фокус-режим: крупная горячая зона
    if (suff.bar) suff.bar.hidden = false;
    if (suff.ask) suff.ask.value = '';
    suffClearTree(); suffAskBuf = ''; suffBufSince = 0; suffRecent = [];
    suffShow();
    suffCapture();
  }
  function suffCapture() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { suffSetStatus('живой захват недоступен — впиши вопрос вручную'); return; }
    suffSetStatus('выбери вкладку со звонком и включи «Поделиться звуком вкладки»…');
    // Кадр суфлёру нужен только для превью и разбора скрина, поэтому частоту режем, а ширину ограничиваем:
    // без ограничений Chrome отдаёт полный retina-кадр (замерено на встрече — 3356×2836), и это лишняя
    // нагрузка на том же созвоне, из-за которой начинает рваться звук.
    var videoWant = { frameRate: { ideal: 8, max: 12 }, width: { max: 1920 }, height: { max: 1200 } };
    navigator.mediaDevices.getDisplayMedia({ video: videoWant, audio: true }).then(function (stream) {
      if (!suffMain) { stream.getTracks().forEach(function (t) { t.stop(); }); return; } // успели выключить
      var au = stream.getAudioTracks();
      if (!au.length) { stream.getTracks().forEach(function (t) { t.stop(); }); suffSetStatus('звук вкладки не выбран — можно вписать вручную', 'err'); return; }
      suffStream = stream; suffTrack = au[0]; suffOn = true;
      var vt = stream.getVideoTracks()[0];
      if (vt && vt.applyConstraints) { try { vt.applyConstraints(videoWant); } catch (e) {} }  // Chrome умеет проигнорировать первые
      // видео вкладки показываем справа (звук у элемента заглушен — без эха; распознавание берёт аудио-трек напрямую)
      if (vt && suff.video) {
        suff.video.srcObject = stream;
        if (suff.videoWrap) suff.videoWrap.hidden = false;
      }
      suffMeterStart(stream);   // полоска громкости: видно, что звук из вкладки реально идёт
      suffTrack.onended = function () { suffCaptureStop(); suffSetStatus('захват остановлен — впиши вручную'); };
      suffRecFails = 0;
      suffStartRec();
    }).catch(function (err) {
      suffSetStatus(err && err.name === 'NotAllowedError' ? 'захват отменён — можно вписать вручную' : 'захват не удался — впиши вручную', 'err');
    });
  }

  if (suff.toggle) suff.toggle.addEventListener('click', function () {
    if (suffMain) suffStop(); else suffEnter();
  });
  if (suff.pause) suff.pause.addEventListener('click', suffPauseToggle);
  if (suff.reset) suff.reset.addEventListener('click', suffReset);
  if (suff.shot) suff.shot.addEventListener('click', suffAskShot);

  // ручной вопрос: ASR не расслышал — вписываешь сам, уходит тем же ИИ-ответом в дерево
  var askTimer = null;
  if (suff.ask) suff.ask.addEventListener('input', function () {
    if (askTimer) clearTimeout(askTimer);
    askTimer = setTimeout(function () {
      askTimer = null;
      var v = suff.ask.value.trim();
      if (!v || !suffMain) return;
      suffAsk(v); suff.ask.value = '';   // спросили — освобождаем поле под следующий
    }, 700);
  });

  window.addEventListener('hashchange', route);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (srcModal && !srcModal.hidden) { closeSrcAdd(); return; }
    if (els.modal && !els.modal.hidden) { closeModal(); return; }
    if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
    if (location.hash) location.hash = '';
  });

  // мини-markdown и подсветка нужны и другим модулям (разбор записи встречи) — отдаём наружу, чтобы не дублировать
  window.SOBES.md = { block: mdBlock, inline: mdInline, esc: escHtml, code: highlightCode };

  route();
  // база карточек грузится в фоне — она нужна только как справка модели в суфлёре
  api.load().then(function (data) {
    ITEMS = data.items || [];
    window.SOBES._items = ITEMS;
    engine.prepare(ITEMS);
  }).catch(function (e) {
    console.warn('база карточек не загрузилась, суфлёр ответит без справки:', e && e.message);
  });
})();
