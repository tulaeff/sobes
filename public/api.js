/* ===== Клиент API (данные и правки — в БД, кэш в Redis) ===== */
(function () {
  'use strict';
  var SOBES = (window.SOBES = window.SOBES || {});

  function req(url, opts) {
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
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
  // POST со стримом: читает тело чанками и отдаёт их в onChunk (для SSE-роутов /ask, /vision)
  function streamPost(url, bodyObj, onChunk) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) })
      .then(function (r) {
        if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
        var reader = r.body.getReader(), dec = new TextDecoder();
        return (function pump() {
          return reader.read().then(function (res) {
            if (res.done) return;
            if (res.value) onChunk(dec.decode(res.value, { stream: true }));
            return pump();
          });
        })();
      });
  }

  SOBES.api = {
    load: function () { return req('/api/cards'); },
    ask: function (question, cards) { return jsonPost('/api/ask', 'POST', { question: question, cards: cards || [] }); },
    askStream: function (question, cards, onChunk, history) {
      return streamPost('/api/ask', { question: question, cards: cards || [], history: history || [] }, onChunk);
    },
    visionStream: function (image, onChunk) {
      return streamPost('/api/vision', { image: image }, onChunk);
    },
    setPin: function (id, pinned) { return jsonPost('/api/cards/' + id + '/pin', 'POST', { pinned: pinned }); },
    clearPins: function () { return jsonPost('/api/pins/clear', 'POST'); },
    saveEdit: function (id, patch) { return jsonPost('/api/cards/' + id, 'PATCH', patch); },
    reset: function (id) { return jsonPost('/api/cards/' + id + '/reset', 'POST'); },
    editPersonal: function (key, patch) { return jsonPost('/api/personal/' + key, 'PATCH', patch); },
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
    analyzeStatus: function () { return req('/api/analyze/status'); }
  };
})();
