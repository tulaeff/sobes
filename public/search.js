/* ===== Универсальный движок поиска ===== */
(function () {
  'use strict';
  var SOBES = (window.SOBES = window.SOBES || {});

  function norm(s) { return (s || '').toString().toLowerCase().replace(/ё/g, 'е'); }
  function stripMd(s) { return (s || '').replace(/[*`>#]/g, ' ').replace(/\s+/g, ' '); }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // --- исправление раскладки RU<->EN (набрал не в той раскладке) ---
  var EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
  var RU = "йцукенгшщзхъфывапролджэячсмитьбюё";
  var en2ru = {}, ru2en = {};
  for (var i = 0; i < EN.length; i++) { en2ru[EN[i]] = RU[i]; ru2en[RU[i]] = EN[i]; }
  function layoutSwap(s) {
    var out = '', changed = false;
    for (var j = 0; j < s.length; j++) {
      var c = s[j];
      if (en2ru[c] != null) { out += en2ru[c]; changed = true; }
      else if (ru2en[c] != null) { out += ru2en[c]; changed = true; }
      else out += c;
    }
    return changed ? out : s;
  }

  // --- транслитерация кириллица -> латиница (сближает "редис" и "redis") ---
  var TR = { а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ж:'zh', з:'z', и:'i', й:'i',
    к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f',
    х:'h', ц:'c', ч:'ch', ш:'sh', щ:'sch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya' };
  function translit(s) {
    var out = '';
    for (var k = 0; k < s.length; k++) { var c = s[k]; out += (TR[c] != null ? TR[c] : c); }
    return out;
  }

  // --- лёгкий стемминг: усечём окончание ("изоляция" -> "изоляци") ---
  function stemOf(t) {
    if (t.length <= 4) return t;
    var trim = t.length >= 8 ? 3 : (t.length >= 6 ? 2 : 1);
    var s = t.slice(0, t.length - trim);
    return s.length >= 4 ? s : t.slice(0, 4);
  }

  function levLE(a, b, max) {
    var al = a.length, bl = b.length;
    if (Math.abs(al - bl) > max) return false;
    var prev = [], cur = [], x, y;
    for (y = 0; y <= bl; y++) prev[y] = y;
    for (x = 1; x <= al; x++) {
      cur[0] = x; var best = x;
      for (y = 1; y <= bl; y++) {
        var cost = a.charCodeAt(x - 1) === b.charCodeAt(y - 1) ? 0 : 1;
        cur[y] = Math.min(prev[y] + 1, cur[y - 1] + 1, prev[y - 1] + cost);
        if (cur[y] < best) best = cur[y];
      }
      if (best > max) return false;
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[bl] <= max;
  }

  // --- предрасчёт индекса по карточке ---
  function reindex(it) {
    it._q = norm(it.q);
    it._a = norm(stripMd(it.a));
    it._detail = norm(stripMd(it.detail || ''));
    it._tags = norm((it.tags || []).join(' '));
    it._cat = norm(it.catTitle || '');
    it._code = norm(it.code || '');
    it._hay = it._q + '  ' + it._tags + '  ' + it._a + '  ' + it._detail + '  ' + it._code + '  ' + it._cat;
    it._hayLat = translit(it._hay);
    it._tokens = it._hay.split(/[^0-9a-zа-я_+#]+/).filter(function (t) { return t.length > 1; });
  }
  function prepare(items) { items.forEach(function (it, idx) { it._i = idx; reindex(it); }); }

  function terms(query) { return norm(query).trim().split(/\s+/).filter(Boolean); }

  // варианты одного терма: сам, основа, раскладка, основа раскладки
  function candsFor(t) {
    var c = [{ s: t, w: 1 }];
    var st = stemOf(t); if (st !== t) c.push({ s: st, w: 0.82 });
    var sw = layoutSwap(t);
    if (sw !== t && /[а-яa-z]/.test(sw)) {
      c.push({ s: sw, w: 0.7 });
      var sst = stemOf(sw); if (sst !== sw) c.push({ s: sst, w: 0.58 });
    }
    return c;
  }
  function fieldScore(field, cands, base) {
    var best = 0;
    for (var i = 0; i < cands.length; i++) {
      if (field.indexOf(cands[i].s) !== -1 && cands[i].w > best) best = cands[i].w;
    }
    return best > 0 ? base * best : 0;
  }

  // очки терма по карточке. -1 если совсем не найден.
  function scoreTerm(it, t, cands, tl) {
    var sQ = fieldScore(it._q, cands, 10);
    if (sQ > 0 && it._q.indexOf(t) === 0) sQ += 6;
    var s = sQ;
    s = Math.max(s, fieldScore(it._tags, cands, 7));
    s = Math.max(s, fieldScore(it._a, cands, 3));
    s = Math.max(s, fieldScore(it._detail, cands, 2));
    s = Math.max(s, fieldScore(it._code, cands, 3));
    s = Math.max(s, fieldScore(it._cat, cands, 2));
    // транслит-сеть: "редис" ~ "redis"
    if (s === 0 && tl && tl.length >= 3 && it._hayLat.indexOf(tl) !== -1) s = 3;
    return s > 0 ? s : -1;
  }

  function fuzzyTerm(it, t, tl) {
    var thr = t.length <= 3 ? 0 : (t.length <= 6 ? 1 : 2);
    if (thr === 0) return -1;
    for (var k = 0; k < it._tokens.length; k++) {
      var tok = it._tokens[k];
      if (Math.abs(tok.length - t.length) <= thr && levLE(t, tok, thr)) return 4 - thr;
      // транслит-версия ("докер" ~ "docker")
      if (tl && tl !== t) { var tokL = translit(tok); if (Math.abs(tokL.length - tl.length) <= thr && levLE(tl, tokL, thr)) return 3 - thr; }
    }
    return -1;
  }

  function run(query, catKey) {
    var ts = terms(query);
    var pool = SOBES._items || [];
    if (catKey && catKey !== '*') pool = pool.filter(function (it) { return it.cat === catKey; });
    if (!ts.length) {
      var p = pool.slice();
      p.sort(function (a, b) {
        var pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0;
        if (pa !== pb) return pb - pa; // закреплённые выше
        var wa = a.weight || 0, wb = b.weight || 0;
        if (wb !== wa) return wb - wa; // популярнее — выше
        return a._i - b._i;
      });
      return p;
    }

    var cands = ts.map(candsFor);
    var tls = ts.map(translit);
    var res = [], i, j, it, total, ok, sc;

    // проход 1: AND по всем термам (учтены основа/раскладка/транслит)
    for (i = 0; i < pool.length; i++) {
      it = pool[i]; total = 0; ok = true;
      for (j = 0; j < ts.length; j++) {
        sc = scoreTerm(it, ts[j], cands[j], tls[j]);
        if (sc < 0) { ok = false; break; }
        total += sc;
      }
      if (ok) res.push([it, total]);
    }
    // проход 2: fuzzy-фолбэк на опечатки
    if (!res.length) {
      for (i = 0; i < pool.length; i++) {
        it = pool[i]; total = 0; ok = true;
        for (j = 0; j < ts.length; j++) {
          sc = scoreTerm(it, ts[j], cands[j], tls[j]);
          if (sc < 0) sc = fuzzyTerm(it, ts[j], tls[j]);
          if (sc < 0) { ok = false; break; }
          total += sc;
        }
        if (ok) res.push([it, total]);
      }
    }

    res.sort(function (a, b) {
      var pa = a[0].pinned ? 1 : 0, pb = b[0].pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      // релевантность + подмешанный вес популярности (макс ~+3), чтобы частые вопросы всплывали выше
      var sa = a[1] + (a[0].weight || 0) * 0.03, sb = b[1] + (b[0].weight || 0) * 0.03;
      if (sb !== sa) return sb - sa;
      if ((b[0].weight || 0) !== (a[0].weight || 0)) return (b[0].weight || 0) - (a[0].weight || 0);
      return a[0]._i - b[0]._i;
    });
    return res.map(function (r) { return r[0]; });
  }

  // служебные слова живой речи — в ретриве не значат ничего
  var RET_STOP = {};
  ('что как какой какая какие каких чем чему где когда почему зачем кто кого это этот эта эти такое такой ли же бы для при про над под без если или но то так там тут вот ещё еще уже только очень вообще кстати вы ты мне нам мы они она оно есть быть был была были будет надо нужно можно может можешь давай скажи расскажи объясни знаешь понимаешь думаешь считаешь свой своя свои твой твоя себе себя тебе тебя наш наше а и в на с по из от до за об у не ни да нет ок хорошо ладно понятно дальше далее вопрос ответ пример примеры разница отличие отличается работает делать сделать использовать используется применяется бывает значит просто именно вообще-то допустим например скажем '
   + 'опыт стаж работа работы работал работать сколько лет год года решал решать решаешь решение проблема проблему проблемы задача задачу задачи разработке разработка компания команда проект проекте' )
    .split(/\s+/).forEach(function (w) { RET_STOP[w] = 1; });

  // ретрив для суфлёра: OR по значимым словам с ранжированием.
  // run() тут не годится — он требует AND по всем термам, и «расскажи про транзакции» даёт пусто.
  // Пусто вернуть НЕ страшно: без карточек модель отвечает своими знаниями.
  function retrieve(query, limit) {
    var pool = SOBES._items || [];
    if (!pool.length) return [];
    var ts = terms(query).filter(function (t) { return t.length >= 3 && !RET_STOP[t]; });
    if (!ts.length) return [];
    if (ts.length > 8) ts = ts.slice(0, 8);

    var cands = ts.map(candsFor);
    var tls = ts.map(translit);
    // одного совпавшего слова мало, когда значимых слов несколько: «опыт работы» иначе цепляет «как работают ретраи»
    var need = ts.length >= 2 ? 2 : 1;
    var res = [], i, j, it, sum, best, hits, sc;

    for (i = 0; i < pool.length; i++) {
      it = pool[i]; sum = 0; best = 0; hits = 0;
      for (j = 0; j < ts.length; j++) {
        sc = scoreTerm(it, ts[j], cands[j], tls[j]);
        if (sc < 0) continue;                 // терм не найден — просто пропускаем, не отбрасываем карточку
        sum += sc; hits++;
        if (sc > best) best = sc;
      }
      if (hits < need) continue;
      // попадание в вопрос/теги карточки, либо уверенная сумма по телу
      if (best >= 7 || sum >= 12) res.push([it, sum + (it.pinned ? 4 : 0) + (it.weight || 0) * 0.03]);
    }
    if (!res.length) return [];

    res.sort(function (a, b) { return b[1] - a[1]; });
    var top = res[0][1];
    return res.filter(function (r) { return r[1] >= top * 0.45; })
              .slice(0, limit || 3)
              .map(function (r) { return r[0]; });
  }

  // список строк для подсветки совпадений (терм + основа + раскладка)
  function highlightList(query) {
    var out = [];
    terms(query).forEach(function (t) {
      out.push(t);
      var st = stemOf(t); if (st !== t && st.length >= 4) out.push(st);
      var sw = layoutSwap(t); if (sw !== t && /[а-яa-z]/.test(sw)) out.push(sw);
    });
    return out;
  }

  // почти одно и то же? Распознавание любит выдать одну фразу дважды с мелкой разницей
  function similar(a, b) {
    a = norm(a || ''); b = norm(b || '');
    if (!a || !b) return false;
    if (a === b) return true;
    var max = Math.max(a.length, b.length);
    // на коротких строках 20% — это меньше символа, поэтому один символ разницы прощаем всегда («ооп» и «ооп?»)
    if (Math.abs(a.length - b.length) > Math.max(1, max * 0.2)) return false;
    return levLE(a, b, Math.max(1, Math.round(max * 0.15)));
  }

  SOBES.search = {
    prepare: prepare, reindex: reindex, run: run, retrieve: retrieve,
    terms: terms, highlightList: highlightList, similar: similar,
    norm: norm, escRe: escRe
  };
})();
