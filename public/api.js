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
    reorderCategories: function (order) { return jsonPost('/api/categories/reorder', 'POST', { order: order }); }
  };
})();
