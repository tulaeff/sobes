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

  SOBES.api = {
    load: function () { return req('/api/cards'); },
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
    notifications: function () { return req('/api/notifications'); },
    markNotifRead: function (id) { return jsonPost('/api/notifications/read', 'POST', id ? { id: id } : {}); },
    analyzeStatus: function () { return req('/api/analyze/status'); }
  };
})();
