/* ===== Клиент API (данные и правки — в БД, кэш в Redis) ===== */
(function () {
  'use strict';
  var SOBES = (window.SOBES = window.SOBES || {});

  function req(url, opts) {
    return fetch(url, opts).then(function (r) {
      if (!r.ok) {                        // текст ошибки от API полезнее голого кода — показываем его пользователю
        return r.json().catch(function () { return null; }).then(function (j) {
          throw new Error((j && j.error) || ('HTTP ' + r.status));
        });
      }
      return r.json();
    });
  }
  function jsonPost(url, method, bodyObj) {
    return req(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: bodyObj ? JSON.stringify(bodyObj) : undefined
    });
  }
  // Дедлайны стрима. Прогретый пул отдаёт первый токен за 0.4-0.7с, так что 8с — это уже «что-то легло»,
  // а не «модель думает». Второй таймер ловит другую беду: ответ пошёл и замолчал на середине.
  var TTFB_MS = 8000;
  var IDLE_MS = 25000;
  function streamErr(kind, msg) { var e = new Error(msg); e.kind = kind; return e; }

  // POST со стримом: читает тело чанками и отдаёт их в onChunk (для SSE-роутов /ask, /vision).
  // signal — внешняя отмена; ошибки помечены kind: timeout | stalled | aborted | http
  function streamPost(url, bodyObj, onChunk, signal) {
    if (signal && signal.aborted) return Promise.reject(streamErr('aborted', 'отменено'));
    var ctrl = new AbortController();
    var timer = null, cause = null;
    function arm(ms, kind, msg) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { cause = streamErr(kind, msg); ctrl.abort(); }, ms);
    }
    function disarm() { if (timer) { clearTimeout(timer); timer = null; } }
    if (signal) signal.addEventListener('abort', function () {
      if (!cause) cause = streamErr('aborted', 'отменено');
      ctrl.abort();
    });

    // управляющий канал: строки «\x1e<op><payload>\n». 'e'=ошибка (сервер её не выдаёт за ответ), 'k'=keepalive.
    // \x1e в тексте модели не встречается. Строка может прийти раскромсанной по чанкам — держим хвост в ctlBuf.
    var ctlBuf = '';
    function feed(text) {
      ctlBuf += text;
      var out = '', i;
      while ((i = ctlBuf.indexOf('\x1e')) !== -1) {
        out += ctlBuf.slice(0, i);
        var nl = ctlBuf.indexOf('\n', i);
        if (nl === -1) { ctlBuf = ctlBuf.slice(i); break; }   // управляющая строка недостримлена — ждём хвост
        var ctl = ctlBuf.slice(i + 1, nl);
        ctlBuf = ctlBuf.slice(nl + 1);
        if (ctl.charAt(0) === 'e') {                          // ошибка сервера → рвём стрим и падаем со своей причиной
          var info; try { info = JSON.parse(ctl.slice(1)); } catch (e) { info = {}; }
          if (out) { arm(IDLE_MS, 'stalled', 'ответ оборвался на середине'); onChunk(out); }
          if (!cause) cause = streamErr(info.kind || 'api', info.message || 'ошибка сервера');
          ctrl.abort();      // закрыть соединение (освободить воркер), но на успех полагаться нельзя
          throw cause;       // сразу вон из pump — иначе следующий read() с done резолвит промис как успех
        }
        // 'k' keepalive и прочее — молча глотаем, таймеры не трогаем (пинг не значит, что модель что-то выдала)
      }
      if (i === -1) { out += ctlBuf; ctlBuf = ''; }
      if (out) { arm(IDLE_MS, 'stalled', 'ответ оборвался на середине'); onChunk(out); }
    }

    arm(TTFB_MS, 'timeout', 'модель не ответила за ' + Math.round(TTFB_MS / 1000) + 'с');
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj), signal: ctrl.signal
    })
      .then(function (r) {
        if (!r.ok || !r.body) throw streamErr('http', 'HTTP ' + r.status);
        var reader = r.body.getReader(), dec = new TextDecoder();
        return (function pump() {
          return reader.read().then(function (res) {
            if (res.done) { var tail = dec.decode(); if (tail) feed(tail); return; }   // хвост многобайтового символа
            if (res.value) feed(dec.decode(res.value, { stream: true }));
            return pump();
          });
        })();
      })
      .then(function () { disarm(); }, function (e) {
        disarm();
        ctrl.abort();   // сюда же падает исключение из onChunk (он трогает DOM) — иначе тело качается в пустоту
        if (cause) throw cause;                                   // свой дедлайн или внешняя отмена
        if (e && e.name === 'AbortError') throw streamErr('aborted', 'отменено');
        if (e && e.kind) throw e;
        throw streamErr('network', (e && e.message) || String(e));
      });
  }

  SOBES.api = {
    load: function () { return req('/api/cards'); },
    asrTerms: function () { return req('/api/asr-terms'); },
    ask: function (question, cards) { return jsonPost('/api/ask', 'POST', { question: question, cards: cards || [] }); },
    askStream: function (question, cards, onChunk, history, signal) {
      return streamPost('/api/ask', { question: question, cards: cards || [], history: history || [] }, onChunk, signal);
    },
    visionStream: function (image, onChunk, signal) {
      return streamPost('/api/vision', { image: image }, onChunk, signal);
    },
    editCategory: function (key, patch) { return jsonPost('/api/categories/' + key, 'PATCH', patch); },
    reorderCategories: function (order) { return jsonPost('/api/categories/reorder', 'POST', { order: order }); },
    listTgFiles: function () { return req('/api/tg-files'); },
    listSources: function () { return req('/api/sources'); },
    addSource: function (s) { return jsonPost('/api/sources', 'POST', s); },
    toggleSource: function (id, enabled) { return jsonPost('/api/sources/' + id, 'PATCH', { enabled: enabled }); },
    setAutoApply: function (id, on) { return jsonPost('/api/sources/' + id, 'PATCH', { auto_apply: on }); },
    deleteSource: function (id) { return req('/api/sources/' + id, { method: 'DELETE' }); },
    listVacancies: function () { return req('/api/vacancies'); },
    deleteVacancy: function (id) { return req('/api/vacancies/' + id, { method: 'DELETE' }); },
    approveApply: function (id) { return jsonPost('/api/vacancies/' + id + '/approve', 'POST'); },
    skipApply: function (id) { return jsonPost('/api/vacancies/' + id + '/skip', 'POST'); },
    markApplied: function (id) { return jsonPost('/api/vacancies/' + id + '/apply', 'PATCH', { apply_status: 'applied' }); },
    saveCoverLetter: function (id, text) { return jsonPost('/api/vacancies/' + id + '/apply', 'PATCH', { cover_letter: text }); },
    saveContacts: function (id, contacts) { return jsonPost('/api/vacancies/' + id + '/contacts', 'PATCH', { hr_contacts: contacts }); },
    markDone: function (id) { return jsonPost('/api/vacancies/' + id + '/done', 'POST'); },
    analyzeStatus: function () { return req('/api/analyze/status'); },

    // --- записи встреч ---
    listRecordings: function () { return req('/api/recordings'); },
    getRecording: function (id) { return req('/api/recordings/' + id); },
    createRecording: function (title, mime) { return jsonPost('/api/recordings', 'POST', { title: title, mime: mime }); },
    // кусок записи уходит сырыми байтами; seq — порядковый номер, по нему сервер отбрасывает повтор после ретрая
    sendChunk: function (id, seq, blob) {
      return req('/api/recordings/' + id + '/chunk?seq=' + seq, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob
      });
    },
    finishRecording: function (id, durationMs) { return jsonPost('/api/recordings/' + id + '/finish', 'POST', { duration_ms: durationMs }); },
    sendLines: function (id, lines) { return jsonPost('/api/recordings/' + id + '/lines', 'POST', { lines: lines }); },
    renameRecording: function (id, title) { return jsonPost('/api/recordings/' + id, 'PATCH', { title: title }); },
    deleteRecording: function (id) { return req('/api/recordings/' + id, { method: 'DELETE' }); },
    // точная расшифровка: ставим в очередь, считает воркер на хосте (whisper.cpp)
    transcribeRecording: function (id) { return jsonPost('/api/recordings/' + id + '/transcribe', 'POST'); }
  };
})();
