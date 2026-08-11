/* ===== Страница «Запись встречи» (роут #record): пульт записи, список записей, расшифровка =====
   Движок — record.js; здесь только DOM. Модуль подписывается на его хуки через window.SOBES.recUI. */
(function () {
  'use strict';
  var SOBES = (window.SOBES = window.SOBES || {});
  var api = SOBES.api;
  var esc = function (t) { return (SOBES.md ? SOBES.md.esc(t) : t); };
  var MIC_KEY = 'sobes:rec-mic';    // выбранный вход помним между встречами
  var QUAL_KEY = 'sobes:rec-quality';

  var el = {
    toggle: document.getElementById('rec-toggle'),
    pause: document.getElementById('rec-pause'),
    status: document.getElementById('rec-status'),
    micBox: document.getElementById('rec-mic-box'),
    micDev: document.getElementById('rec-mic-dev'),
    micRefresh: document.getElementById('rec-mic-refresh'),
    qual: document.getElementById('rec-qual'),
    levelBar: document.getElementById('rec-level-bar'),
    levelHint: document.getElementById('rec-level-hint'),
    live: document.getElementById('rec-live'),
    preview: document.getElementById('rec-preview'),
    timer: document.getElementById('rec-timer'),
    meta: document.getElementById('rec-live-meta'),
    trans: document.getElementById('rec-live-trans'),
    list: document.getElementById('rec-list'),
    count: document.getElementById('rec-count'),
    back: document.getElementById('backHomeRec')
  };
  if (!el.toggle || !el.list) return;

  // ---- формат ----
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function hms(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return (h ? h + ':' + two(m) : two(m)) + ':' + two(s % 60);
  }
  function size(b) {
    if (!b) return '0 МБ';
    if (b < 1048576) return Math.round(b / 1024) + ' КБ';
    return (b / 1048576).toFixed(b > 104857600 ? 0 : 1) + ' МБ';
  }
  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return two(d.getDate()) + '.' + two(d.getMonth() + 1) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }
  function btn(text, cls, on) {
    var b = document.createElement('button'); b.type = 'button';
    b.className = 'btn' + (cls ? ' ' + cls : ''); b.textContent = text; b.onclick = on;
    return b;
  }

  // MediaRecorder не пишет длительность в заголовок webm — у свежего файла duration = Infinity и перемотка мертва.
  // Проверенный обход: увести currentTime в конец, дождаться реальной длительности и вернуться в начало.
  function fixSeek(video) {
    video.addEventListener('loadedmetadata', function () {
      if (video.duration !== Infinity) return;
      var back = function () {
        video.removeEventListener('durationchange', back);
        video.currentTime = 0;
      };
      video.addEventListener('durationchange', back);
      video.currentTime = 1e101;
    });
  }

  // ---- микрофон: выбор входа и живая полоска громкости ----
  // Chrome по умолчанию берёт системный вход, а он бывает немым (встроенный микрофон MacBook при
  // подключённых AirPods отдаёт ровно нули) — поэтому вход выбирается руками, а полоска показывает, слышно ли тебя.
  var silentTicks = 0, heard = false;
  function setLevel(rms) {
    var pct = Math.min(100, Math.round(Math.sqrt(Math.max(0, rms)) * 350));
    el.levelBar.style.width = pct + '%';
    el.levelBar.classList.toggle('quiet', pct < 4);
    if (rms >= 0.0005) { silentTicks = 0; heard = true; el.levelHint.textContent = 'слышно'; el.levelHint.className = 'rec-level-hint ok'; return; }
    if (++silentTicks > 40) {          // ~5 секунд тишины подряд
      el.levelHint.textContent = 'этот вход молчит — выбери другой';
      el.levelHint.className = 'rec-level-hint err';
    }
  }
  function resetLevel(text) {
    silentTicks = 0; heard = false;
    el.levelBar.style.width = '0%';
    el.levelHint.textContent = text || 'скажи что-нибудь — полоска должна дёргаться';
    el.levelHint.className = 'rec-level-hint';
  }
  var devSig = '';                                  // состав входов, чтобы отличать реальные изменения от эха
  function sigOf(list) { return list.map(function (m) { return m.id; }).sort().join('|'); }
  function fillMics() {
    return SOBES.rec.mics().then(function (list) {
      var saved = localStorage.getItem(MIC_KEY) || '';
      devSig = sigOf(list);
      el.micDev.innerHTML = '';
      if (!list.length) {
        el.micDev.innerHTML = '<option value="">микрофонов не видно</option>';
        return null;
      }
      var have = false;
      list.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.id; o.textContent = m.label;
        if (m.id === saved) { o.selected = true; have = true; }
        el.micDev.appendChild(o);
      });
      return have ? saved : (list[0] ? list[0].id : null);
    });
  }
  var PROBE_MS = 3000;   // послушали, показали полоску и отпустили микрофон
  function startProbe() {
    if (SOBES.rec.active()) return;
    SOBES.rec.probe(el.micDev.value || null, PROBE_MS)
      .then(function () { resetLevel('слушаю вход пару секунд…'); })
      .catch(function (e) {
        el.levelHint.textContent = (e && e.name === 'NotAllowedError') ? 'доступ к микрофону закрыт' : 'микрофон не открылся';
        el.levelHint.className = 'rec-level-hint err';
      });
  }
  function stopProbe() { if (SOBES.rec) SOBES.rec.probeStop(); }

  // вход подбирается сам: слушаем каждый и берём первый, где есть сигнал (немой отдаёт ровно нули).
  // Сохранённый вход проверяем первым — если он живой, ничего не меняем.
  var picking = false;
  function autoSetup(force, withProbe) {
    if (picking || SOBES.rec.active()) return Promise.resolve();
    picking = true;
    stopProbe();
    var saved = force ? null : (localStorage.getItem(MIC_KEY) || null);
    // Уже подобранный вход заново не мучаем: открытие bluetooth-микрофона занимает секунды и переводит
    // наушники в режим гарнитуры. Просто ставим его в селект; перепроверка — по ↻ и при старте записи.
    if (saved) {
      return fillMics().then(function () {
        picking = false;
        var has = Array.prototype.some.call(el.micDev.options, function (o) { return o.value === saved; });
        if (has) {
          el.micDev.value = saved;
          resetLevel('вход: ' + (el.micDev.selectedOptions[0] || {}).textContent + ' · ↻ проверить');
          return;
        }
        return autoSetup(true, withProbe);      // сохранённого входа больше нет (отключили наушники) — ищем заново
      });
    }
    resetLevel('подбираю рабочий вход…');
    // список рисуем сразу: подбор может затянуться на bluetooth-входе, но выбор руками должен быть доступен
    return fillMics().then(function () {
      return SOBES.rec.autoPick(null);
    }).then(function (r) {
      picking = false;
      if (r && r.deviceId) {
        localStorage.setItem(MIC_KEY, r.deviceId);
        var has = Array.prototype.some.call(el.micDev.options, function (o) { return o.value === r.deviceId; });
        if (has) el.micDev.value = r.deviceId;
      }
      if (withProbe) { startProbe(); return; }
      // без пробы микрофон сразу отпущен: страница не должна держать его открытым просто так
      var name = (el.micDev.selectedOptions[0] || {}).textContent || 'вход';
      if (r && r.peak > 0) { el.levelHint.textContent = name + ' · сигнал есть'; el.levelHint.className = 'rec-level-hint ok'; }
      else { el.levelHint.textContent = name + ' · сигнал не поймал, скажи что-нибудь и жми ↻'; el.levelHint.className = 'rec-level-hint'; }
    }).catch(function () { picking = false; resetLevel('микрофон не открылся'); });
  }
  el.micDev.addEventListener('change', function () {
    localStorage.setItem(MIC_KEY, el.micDev.value);   // ручное переопределение важнее автоподбора
    startProbe();
  });
  if (el.micRefresh) el.micRefresh.addEventListener('click', function () { autoSetup(true, true); });
  // Список входов меняется на лету (воткнул наушники) — тогда перебираем заново. НО: сам перебор открывает
  // устройства и Chrome шлёт devicechange в ответ — без сверки состава это уходило в бесконечный цикл и вешало вкладку.
  var devTimer = null;
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', function () {
    if (location.hash !== '#record' || picking || SOBES.rec.active()) return;
    if (devTimer) clearTimeout(devTimer);
    devTimer = setTimeout(function () {
      devTimer = null;
      SOBES.rec.mics().then(function (list) {
        if (sigOf(list) === devSig) return;     // те же входы — это эхо нашей же пробы, не трогаем
        autoSetup(true, false);
      });
    }, 1500);
  });
  window.addEventListener('hashchange', function () {
    if (location.hash !== '#record' && !SOBES.rec.active()) stopProbe();
  });

  // ---- пульт записи (сайдбар) ----
  function setToggle(on) {
    el.toggle.textContent = on ? '⏹ Остановить запись' : '🎥 Начать запись';
    el.toggle.classList.toggle('on', !!on);
    el.micDev.disabled = !!on;
    if (el.micRefresh) el.micRefresh.disabled = !!on;
    if (el.pause) { el.pause.hidden = !on; setPause(on && SOBES.rec.paused()); }
  }
  function setPause(paused) {
    if (el.pause) {
      el.pause.textContent = paused ? '▶ Продолжить' : '⏸ Пауза';
      el.pause.classList.toggle('on', !!paused);
    }
    if (el.live) el.live.classList.toggle('paused', !!paused);
    var dot = document.getElementById('rec-dot');
    if (dot) dot.classList.toggle('paused', !!paused);
  }
  if (el.pause) el.pause.addEventListener('click', function () {
    if (!SOBES.rec || !SOBES.rec.active()) return;
    if (SOBES.rec.paused()) SOBES.rec.resume(); else SOBES.rec.pause();
  });
  el.toggle.addEventListener('click', function () {
    if (!SOBES.rec) return;
    if (SOBES.rec.active()) {
      el.toggle.disabled = true;
      // после остановки микрофон отпускаем совсем — заново занимать его пробой незачем
      SOBES.rec.stop().then(function () { el.toggle.disabled = false; resetLevel('микрофон свободен · ↻ чтобы проверить'); });
      return;
    }
    el.toggle.disabled = true;
    SOBES.rec.start({ deviceId: el.micDev.value || null, quality: el.qual ? el.qual.value : 'light' })
      .then(function () { el.toggle.disabled = false; })
      .catch(function () { el.toggle.disabled = false; startProbe(); });
  });
  if (el.qual) {
    el.qual.value = localStorage.getItem(QUAL_KEY) || 'light';
    el.qual.addEventListener('change', function () { localStorage.setItem(QUAL_KEY, el.qual.value); });
  }
  if (el.back) el.back.addEventListener('click', function (e) { e.preventDefault(); location.hash = ''; });

  // ---- хуки движка ----
  SOBES.recUI = {
    onState: function (msg, cls) {
      el.status.textContent = msg || '';
      el.status.className = 'rec-status' + (cls ? ' ' + cls : '');
    },
    onMicLevel: function (m) { setLevel(m && m.level); },
    // проба закончилась — микрофон отпущен (иначе AirPods весь сеанс сидели бы в режиме гарнитуры)
    onProbeEnd: function () {
      el.levelBar.style.width = '0%';
      if (el.levelHint.className.indexOf('err') !== -1) return;
      el.levelHint.textContent = heard ? 'вход рабочий · во время записи слушаю его' : 'сигнала не было — жми ↻ и скажи что-нибудь';
      el.levelHint.className = 'rec-level-hint' + (heard ? ' ok' : '');
    },
    onStart: function () {
      setToggle(true);
      resetLevel();
      el.live.hidden = false;
      el.trans.innerHTML = '';
      el.timer.textContent = '00:00';
      var s = SOBES.rec.stream();
      if (s && el.preview) el.preview.srcObject = s;
      load();
    },
    onStop: function () {
      setToggle(false);
      el.live.hidden = true;
      if (el.preview) { try { el.preview.pause(); } catch (e) {} el.preview.srcObject = null; }
      load();
    },
    onPause: function (paused) { setPause(paused); },
    onTick: function (t) {
      el.timer.textContent = hms(t.ms);
      var parts = [];
      if (t.paused) parts.push('⏸ на паузе');
      parts.push(size(t.sent) + ' на сервере');
      if (t.queue) parts.push('в очереди ' + t.queue);
      if (t.lines) parts.push(t.lines + ' реплик');
      if (!t.micOn) parts.push('без микрофона');
      var vi = SOBES.rec.info().video;
      if (vi) parts.push(vi);
      el.meta.textContent = parts.join(' · ');
    },
    onLine: function (line) {
      var d = document.createElement('div'); d.className = 'rec-line';
      var who = line.speaker === 'me' ? '<span class="rec-who me">я</span>'
              : (line.speaker === 'them' ? '<span class="rec-who them">он</span>' : '');
      d.innerHTML = '<span class="rec-line-t">' + hms(line.t) + '</span>' + who + esc(line.text);
      el.trans.appendChild(d);
      var int = el.trans.querySelector('.rec-interim');
      if (int) el.trans.appendChild(int);           // «на лету» держим последней строкой
      el.trans.scrollTop = el.trans.scrollHeight;
    },
    onInterim: function (text, speaker) {
      var cls = 'rec-interim' + (speaker ? ' s-' + speaker : '');
      var int = el.trans.querySelector('.' + (speaker ? 's-' + speaker : 'rec-interim'));
      if (!int) { int = document.createElement('div'); el.trans.appendChild(int); }
      int.className = cls;
      int.textContent = (speaker === 'me' ? 'я: ' : (speaker === 'them' ? 'он: ' : '')) + text;
      el.trans.scrollTop = el.trans.scrollHeight;
    },
    onAsr: function (state) {
      if (state && state !== 'off' && state !== 'пишу расшифровку') el.meta.textContent = '⚠ ' + state;
    },
    open: function () {
      load();
      if (!SOBES.rec) return;
      setToggle(SOBES.rec.active());
      if (SOBES.rec.active()) return;
      // Вход подбираем сразу при открытии — иначе в наушниках окажется выбран немой встроенный микрофон.
      // Все обращения к микрофону под дедлайнами, поэтому неотвечающий вход больше не вешает страницу.
      autoSetup(false, false);
    }
  };

  // ---- список записей ----
  var REC_BADGE = {
    recording: ['● идёт запись', 'live'],
    done: ['✅ готова', 'ok'],
    failed: ['⚠ не записалась', 'err']
  };

  // в имени файла двоеточие из «Встреча 03.08 11:49» и слэши — мусор для файловой системы
  function fileName(r, ext) {
    return ((r.title || 'meeting').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'meeting') + ext;
  }
  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  // расшифровка уезжает рядом с видео отдельным .txt — так её можно читать и пересылать без плеера
  function downloadTranscript(r) {
    if (!r.lines) return;
    api.getRecording(r.id).then(function (res) {
      var lines = res.lines || [];
      if (!lines.length) return;
      var head = (r.title || 'Встреча') + '\n'
        + when(r.startedAt) + (r.durationMs ? ' · ' + hms(r.durationMs) : '') + '\n\n';
      var body = lines.map(function (l) {
        var who = l.speaker === 'me' ? 'Я: ' : (l.speaker === 'them' ? 'Собеседник: ' : '');
        return '[' + hms(l.t) + '] ' + who + l.text;
      }).join('\n');
      saveBlob(new Blob([head + body + '\n'], { type: 'text/plain;charset=utf-8' }), fileName(r, '.txt'));
    }).catch(function () { alert('видео скачалось, а расшифровка — нет'); });
  }

  // ---- точная расшифровка (whisper на хосте) ----
  var WHISPER_LABEL = {
    queued:  ['⏳ в очереди на точную расшифровку', ''],
    running: ['⚙️ считаю точную расшифровку…', ''],
    done:    ['🎯 расшифровка точная', 'ok'],
    failed:  ['⚠ точная расшифровка не вышла', 'err']
  };
  function whisperControl(r, card) {
    var st = r.whisperStatus || '';
    if (st === 'queued' || st === 'running' || st === 'done') {
      var lab = WHISPER_LABEL[st];
      var s = document.createElement('span');
      s.className = 'rec-whisper' + (lab[1] ? ' ' + lab[1] : '');
      s.textContent = lab[0];
      if (r.whisperNote) s.title = r.whisperNote;
      return s;
    }
    var b = btn(st === 'failed' ? '↻ Точная расшифровка' : '🎯 Точная расшифровка', '', function () {
      b.disabled = true;
      b.textContent = 'ставлю в очередь…';
      api.transcribeRecording(r.id).then(function () { load(); }).catch(function (e) {
        b.disabled = false;
        b.textContent = '↻ Точная расшифровка';
        alert((e && e.message) || 'не вышло');
      });
    });
    b.title = 'Прогнать запись через whisper на этой машине: медленнее, но заметно точнее черновой расшифровки браузера'
      + (r.whisperNote ? ' · ' + r.whisperNote : '');
    return b;
  }

  function removeRec(r) {
    if (!confirm('Удалить запись «' + (r.title || '') + '» вместе с видеофайлом и расшифровкой?')) return;
    api.deleteRecording(r.id).then(load).catch(function () { alert('не удалось удалить'); });
  }

  function titleRow(card, r) {
    var row = document.createElement('div'); row.className = 'rec-h';
    var t = document.createElement('div'); t.className = 'rec-t'; t.textContent = r.title || 'Без названия';
    var edit = document.createElement('button'); edit.type = 'button'; edit.className = 'rec-rename'; edit.textContent = '✎';
    edit.title = 'Переименовать';
    edit.onclick = function () {
      var inp = document.createElement('input'); inp.className = 'rec-t-input'; inp.value = r.title || '';
      t.replaceWith(inp); inp.focus(); inp.select();
      var save = function () {
        var v = inp.value.trim() || r.title;
        r.title = v; t.textContent = v; inp.replaceWith(t);
        api.renameRecording(r.id, v).catch(function () { alert('не удалось переименовать'); });
      };
      inp.onblur = save;
      inp.onkeydown = function (e) { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = r.title; inp.blur(); } };
    };
    var b = REC_BADGE[r.status] || REC_BADGE.done;
    var badge = document.createElement('span'); badge.className = 'rec-badge b-' + b[1]; badge.textContent = b[0];
    var meta = document.createElement('span'); meta.className = 'rec-meta';
    meta.textContent = when(r.startedAt) + (r.durationMs ? ' · ' + hms(r.durationMs) : '') + (r.size ? ' · ' + size(r.size) : '');
    row.appendChild(t); row.appendChild(edit); row.appendChild(badge); row.appendChild(meta);
    card.appendChild(row);
  }

  // расшифровку тянем лениво, по первому раскрытию
  function transcriptBlock(r, openVideo) {
    var box = document.createElement('div'); box.className = 'rec-detail hide';
    var loaded = false;
    function fetchLines() {
      if (loaded) return;
      loaded = true;
      box.innerHTML = '<div class="src-empty">загружаю расшифровку…</div>';
      api.getRecording(r.id).then(function (res) {
        var lines = res.lines || [];
        box.innerHTML = '';
        var head = document.createElement('div'); head.className = 'rec-sub';
        head.textContent = (r.transcriptKind === 'whisper' ? '🎯 Точная расшифровка' : '📝 Черновая расшифровка')
          + (lines.length ? ' (' + lines.length + ')' : '');
        box.appendChild(head);
        if (!lines.length) {
          box.insertAdjacentHTML('beforeend', '<div class="src-empty">речь не расшифрована — запись шла без распознавания или все реплики пустые</div>');
          return;
        }
        var list = document.createElement('div'); list.className = 'rec-lines';
        lines.forEach(function (l) {
          var d = document.createElement('div'); d.className = 'rec-line';
          var t = document.createElement('span'); t.className = 'rec-line-t'; t.textContent = hms(l.t);
          d.appendChild(t);
          if (l.speaker === 'me' || l.speaker === 'them') {
            var who = document.createElement('span');
            who.className = 'rec-who ' + l.speaker;
            who.textContent = l.speaker === 'me' ? 'я' : 'он';
            d.appendChild(who);
          }
          d.appendChild(document.createTextNode(l.text));
          d.title = 'Перемотать видео сюда';
          d.onclick = function () {                      // расшифровка — навигация по видео, а не просто текст
            var v = openVideo && openVideo();             // свёрнутый плеер по клику разворачивается сам
            if (!v) return;
            v.currentTime = l.t / 1000;
            v.play().catch(function () {});
          };
          list.appendChild(d);
        });
        box.appendChild(list);
      }).catch(function (e) {
        loaded = false;
        box.innerHTML = '<div class="rec-err">⚠ ' + esc((e && e.message) || 'ошибка') + '</div>';
      });
    }
    return { box: box, open: fetchLines };
  }

  function recCard(r) {
    var card = document.createElement('article'); card.className = 'rec';
    titleRow(card, r);

    // Плеер по умолчанию свёрнут и создаётся лениво: развёрнутые видео занимали по пол-экрана каждое,
    // а preload=metadata у всех сразу дёргал файлы, которые никто не смотрит.
    var video = null, videoWrap = null, videoBtn = null;
    if (r.status === 'recording') {
      // файл ещё дописывается — плеер показал бы вечную крутилку вместо картинки
      card.insertAdjacentHTML('beforeend', '<div class="src-empty">запись идёт — плеер появится, когда остановишь</div>');
    } else if (r.status === 'failed') {
      card.insertAdjacentHTML('beforeend', '<div class="src-empty">файл пустой — запись не пошла (обычно не дали доступ к вкладке)</div>');
    } else if (r.url) {
      videoWrap = document.createElement('div');
      videoWrap.className = 'rec-video-wrap hide';
      card.appendChild(videoWrap);
    }
    function ensureVideo() {
      if (video || !videoWrap) return video;
      video = document.createElement('video');
      video.className = 'rec-video'; video.controls = true; video.preload = 'metadata'; video.src = r.url;
      fixSeek(video);
      videoWrap.appendChild(video);
      return video;
    }
    function showVideo(on) {
      if (!videoWrap) return null;
      if (on === undefined) on = videoWrap.classList.contains('hide');
      if (on) ensureVideo();
      videoWrap.classList.toggle('hide', !on);
      if (videoBtn) videoBtn.textContent = on ? '⌃ Свернуть видео' : '▶ Смотреть';
      return video;
    }

    var d = transcriptBlock(r, function () { return showVideo(true); });
    var row = document.createElement('div'); row.className = 'rec-actions';
    if (videoWrap) {
      videoBtn = btn('▶ Смотреть', '', function () { showVideo(); });
      row.appendChild(videoBtn);
    }
    var more = btn('📝 Расшифровка' + (r.lines ? ' · ' + r.lines : ''), '', function () {
      var hidden = d.box.classList.toggle('hide');
      more.textContent = (hidden ? '📝 Расшифровка' : '⌃ Свернуть') + (r.lines ? ' · ' + r.lines : '');
      if (!hidden) d.open();
    });
    row.appendChild(more);
    if (r.url && r.status === 'done') {
      var dl = document.createElement('a'); dl.className = 'btn'; dl.href = r.url; dl.download = fileName(r, '.webm');
      dl.textContent = r.lines ? '⬇ Скачать видео + текст' : '⬇ Скачать';
      dl.title = r.lines ? 'Видео и расшифровка (.txt) рядом' : 'Видео (расшифровки нет)';
      dl.addEventListener('click', function () { downloadTranscript(r); });   // видео качает сама ссылка
      row.appendChild(dl);
    }
    if (r.status === 'done') row.appendChild(whisperControl(r, card));
    row.appendChild(btn('🗑 Удалить', 'danger', function () { removeRec(r); }));
    card.appendChild(row);
    card.appendChild(d.box);
    return card;
  }

  // app.js зовёт route() ДО того, как подключён этот файл, поэтому при прямом заходе (или F5) на #record
  // его вызов SOBES.recUI.open() уходил в пустоту и список не грузился — открываем страницу сами.
  function openIfRecord() { if (location.hash === '#record') SOBES.recUI.open(); }
  window.addEventListener('hashchange', openIfRecord);

  var loading = false, pollTimer = null;
  function load() {
    if (loading) return;
    loading = true;
    api.listRecordings().then(function (list) {
      loading = false;
      el.list.innerHTML = '';
      if (el.count) el.count.textContent = list.length ? '(' + list.length + ')' : '';
      if (!list.length) {
        el.list.innerHTML = '<div class="src-empty">Записей пока нет. Нажми «Начать запись», выбери вкладку со встречей и обязательно включи «Поделиться звуком вкладки».</div>';
        return;
      }
      list.forEach(function (r) { el.list.appendChild(recCard(r)); });
      var busy = list.some(function (r) { return r.whisperStatus === 'queued' || r.whisperStatus === 'running'; });
      if (busy && !pollTimer) pollTimer = setInterval(function () { if (location.hash === '#record') load(); }, 15000);
      if (!busy && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }).catch(function (e) {
      loading = false;
      el.list.innerHTML = '<div class="rec-err">⚠ не загрузить список: ' + esc((e && e.message) || '') + '</div>';
    });
  }
  openIfRecord();
})();
