/* ===== Запись встречи: захват вкладки + микрофон → один файл на сервере + расшифровка речи =====
   Движок. Живёт независимо от страницы: уход в шпаргалку/мониторинг запись НЕ прерывает.
   UI подписывается через window.SOBES.recUI (хуки onState/onTick/onLine) — модуль сам DOM не трогает,
   кроме точки-индикатора в сайдбаре. */
(function () {
  'use strict';
  var SOBES = (window.SOBES = window.SOBES || {});
  var api = SOBES.api;

  var CHUNK_MS = 5000;          // кусок записи = 5с: чаще — лишние запросы, реже — больше потерь при падении вкладки
  var LINES_BATCH = 8;          // столько реплик копим, прежде чем слать пачкой
  var LINES_EVERY = 12000;      // …но не реже, чем раз в 12с — иначе конец встречи уедет одним комком
  var AUDIO_BPS = 128000;

  var SILENT_RMS = 0.0005;      // ниже этого считаем, что микрофон молчит (у живого даже в тишине шум выше)
  var SILENT_WARN_MS = 8000;    // столько молчит — и говорим об этом вслух, а не задним числом после встречи

  var st = {
    id: null, file: '', rec: null, mixed: null, display: null, mic: null,
    ctx: null, dest: null, startedAt: 0, stopping: false, starting: false,
    paused: false, pauseAt: 0, pausedMs: 0,
    seq: 0, queue: [], busy: false, fails: 0, sent: 0,
    lines: [], pending: [], linesTimer: null,
    asrs: [], asrState: 'off',
    micOn: false, micLabel: '', micLevel: null, micLoudAt: 0, tabAudioOn: false, videoInfo: '', err: ''
  };

  // замер громкости ветки: RMS 0..~0.3. Нужен, чтобы «мой голос не записался» было видно ДО конца встречи
  function meter(ctx, node) {
    var an = ctx.createAnalyser();
    an.fftSize = 1024;
    node.connect(an);
    var buf = new Float32Array(an.fftSize);
    return function () {
      an.getFloatTimeDomainData(buf);
      var acc = 0;
      for (var i = 0; i < buf.length; i++) acc += buf[i] * buf[i];
      return Math.sqrt(acc / buf.length);
    };
  }

  // список микрофонов. Chrome по умолчанию берёт системный вход, а он вполне может быть немым
  // (встроенный микрофон MacBook при активных AirPods отдаёт ровно нули) — поэтому выбираем руками.
  function listMics() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve([]);
    return navigator.mediaDevices.enumerateDevices().then(function (devs) {
      return devs.filter(function (d) { return d.kind === 'audioinput'; })
        .map(function (d, i) { return { id: d.deviceId, label: d.label || ('микрофон ' + (i + 1)) }; });
    }).catch(function () { return []; });
  }
  function micConstraint(deviceId) {
    var c = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (deviceId) c.deviceId = { exact: deviceId };
    return c;
  }
  // порядок предпочтения входов: явная гарнитура → «по умолчанию» → встроенный микрофон ноутбука
  function micRank(label) {
    var l = (label || '').toLowerCase();
    if (/built-?in|встроен/.test(l)) return 2;
    if (/^по умолчанию|^default/.test(l)) return 1;
    return 0;
  }
  // для ЗАМЕРА обработку выключаем: с шумодавом живой микрофон в тишине тоже отдаёт ровные нули,
  // и вход не отличить от немого. Сырой поток у рабочего входа всегда шумит.
  function rawConstraint(deviceId) {
    var c = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (deviceId) c.deviceId = { exact: deviceId };
    return c;
  }

  // bluetooth-вход умеет открываться секундами (AirPods переключаются в режим гарнитуры), а то и вовсе
  // не отвечать — поэтому у каждой пробы свой дедлайн, иначе подбор висит и тянет за собой всю страницу
  function withDeadline(promise, ms, fallback) {
    return Promise.race([
      promise,
      new Promise(function (resolve) { setTimeout(function () { resolve(fallback); }, ms); })
    ]);
  }

  // послушать конкретный вход и вернуть его пик — по нему отличаем живой микрофон от немого
  function measure(deviceId, ms) {
    return navigator.mediaDevices.getUserMedia({ audio: rawConstraint(deviceId) }).then(function (s) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx();
      var level = meter(ctx, ctx.createMediaStreamSource(s));
      var track = s.getAudioTracks()[0] || {};
      var settings = track.getSettings ? track.getSettings() : {};
      return new Promise(function (resolve) {
        // первые 300мс пропускаем: bluetooth-гарнитура в этот момент ещё переключается и честно отдаёт нули
        var warmup = 3, peak = 0, left = Math.max(4, Math.round(ms / 100)) + warmup;
        var iv = setInterval(function () {
          if (warmup-- <= 0) peak = Math.max(peak, level());
          if (--left > 0) return;
          clearInterval(iv);
          s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
          try { ctx.close(); } catch (e) {}
          resolve({ deviceId: settings.deviceId || deviceId || '', label: track.label || '', peak: peak });
        }, 100);
      });
    });
  }
  // Подобрать рабочий вход. Немой вход выдаёт РОВНО нули (проверено на встроенном микрофоне MacBook),
  // а живой шумит даже в тишине — поэтому берём первый, где есть хоть один ненулевой сэмпл.
  function autoPick(preferId) {
    return listMics().then(function (mics) {
      if (!mics.length) return null;
      // Наушники важнее встроенного: он у нас доказанно немой, а человек в гарнитуре ждёт, что писать
      // будут именно её. Поэтому внешние входы идут первыми — и в них же упираемся, если сигнала не нашли.
      var ranked = mics.slice().sort(function (a, b) { return micRank(a.label) - micRank(b.label); });
      var ids = [];
      if (preferId) ids.push(preferId);
      ranked.forEach(function (m) { if (ids.indexOf(m.id) === -1) ids.push(m.id); });
      ids = ids.slice(0, 4);          // перебирать десяток входов ради подбора незачем
      var i = 0;
      function next() {
        if (i >= ids.length) return { deviceId: ids[0], label: '', peak: 0 };   // все молчат — вернём первый
        var id = ids[i++];
        return withDeadline(measure(id, 900), 6000, null).then(function (r) {
          return (r && r.peak > 0) ? r : next();
        }).catch(function () { return next(); });
      }
      return next();
    }).catch(function () { return null; });
  }

  // проба микрофона до записи: тот же замер, чтобы полоска в сайдбаре жила и до старта
  var probe = { stream: null, ctx: null, level: null, timer: null };
  function probeStop() {
    if (probe.timer) { clearInterval(probe.timer); probe.timer = null; }
    if (probe.stream) { probe.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); probe.stream = null; }
    if (probe.ctx) { try { probe.ctx.close(); } catch (e) {} probe.ctx = null; }
    probe.level = null;
  }
  // Проба короткая и по требованию: держать микрофон открытым всё время, пока висит страница, нельзя —
  // bluetooth-гарнитура от этого уходит в режим HFP и звук в наушниках портится.
  function probeStart(deviceId, ms) {
    probeStop();
    if (active()) return Promise.reject(new Error('идёт запись'));
    return navigator.mediaDevices.getUserMedia({ audio: micConstraint(deviceId) }).then(function (s) {
      probe.stream = s;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      probe.ctx = new Ctx();
      probe.level = meter(probe.ctx, probe.ctx.createMediaStreamSource(s));
      probe.timer = setInterval(function () {
        if (probe.level) hook('onMicLevel', { level: probe.level(), live: true });
      }, 120);
      if (ms) setTimeout(function () { probeStop(); hook('onProbeEnd'); }, ms);
      return { label: (s.getAudioTracks()[0] || {}).label || '' };
    });
  }

  function hook(name, a, b) {
    var ui = SOBES.recUI;
    if (ui && typeof ui[name] === 'function') { try { ui[name](a, b); } catch (e) {} }
  }
  function setState(msg, cls) {
    st.err = cls === 'err' ? (msg || '') : '';
    hook('onState', msg, cls);
    var dot = document.getElementById('rec-dot');
    if (dot) dot.hidden = !st.rec;
  }
  function active() { return !!st.rec; }
  // время самой записи, без пауз: MediaRecorder на паузе ничего не пишет, значит и в файле этих секунд нет.
  // По нему же считаются таймкоды реплик — иначе расшифровка разъедется с видео на длину паузы.
  function elapsed() {
    if (!st.startedAt) return 0;
    return Math.max(0, (st.pauseAt || Date.now()) - st.startedAt - st.pausedMs);
  }

  // ---- заливка кусков: очередь строго по порядку, кусок не выбрасываем никогда ----
  function enqueue(blob) {
    if (!blob || !blob.size) return;
    st.queue.push(blob);
    pump();
  }
  function pump() {
    if (st.busy || !st.queue.length || !st.id) return;
    st.busy = true;
    var blob = st.queue[0], seq = st.seq;
    api.sendChunk(st.id, seq, blob).then(function () {
      st.queue.shift(); st.seq++; st.sent += blob.size;
      st.busy = false; st.fails = 0;
      hook('onProgress', { sent: st.sent, queue: st.queue.length });
      pump();
    }).catch(function (e) {
      st.busy = false; st.fails++;
      // сервер/сеть отвалились — держим кусок в очереди и пробуем снова, иначе в файле будет дыра
      setState('кусок не залился (' + (e && e.message || 'ошибка') + '), повторяю… в очереди ' + st.queue.length, 'err');
      setTimeout(pump, Math.min(1200 * st.fails, 8000));
    });
  }
  // дождаться, пока очередь уйдёт на сервер (на стопе). true — всё залилось
  function flushQueue(timeoutMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function wait() {
        if (!st.queue.length && !st.busy) return resolve(true);
        if (Date.now() - t0 > timeoutMs) return resolve(false);
        pump();
        setTimeout(wait, 300);
      })();
    });
  }

  // ---- коррекция терминов: та же карта поломок, что у суфлёра («кофта» → Kafka) ----
  // Распознавание русское и английские термины ломает под созвучные слова; без правки расшифровка
  // встречи читается как бред именно в тех местах, где обсуждали стек.
  var fixRules = [], fixLoading = false;
  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function loadFixes() {
    if (fixRules.length || fixLoading || !api.asrTerms) return;
    fixLoading = true;
    api.asrTerms().then(function (d) {
      var fixes = (d && d.fixes) || {};
      Object.keys(fixes).sort(function (a, b) { return b.length - a.length; }).forEach(function (k) {
        fixRules.push({
          re: new RegExp('(^|[^0-9a-zа-яё])' + escRe(k) + '(?![0-9a-zа-яё])', 'gi'),
          to: fixes[k]
        });
      });
      fixLoading = false;
    }).catch(function () { fixLoading = false; });   // не вышло — пишем как распозналось
  }
  function fixTerms(text) {
    var out = text;
    for (var i = 0; i < fixRules.length; i++) {
      out = out.replace(fixRules[i].re, (function (to) {
        return function (m, pre) { return pre + to; };
      })(fixRules[i].to));
    }
    return out;
  }

  // ---- расшифровка: реплики уходят пачками, на ошибке возвращаются в накопитель ----
  function flushLines() {
    if (!st.id || !st.pending.length) return Promise.resolve();
    var batch = st.pending;
    st.pending = [];
    return api.sendLines(st.id, batch).catch(function () {
      st.pending = batch.concat(st.pending);   // не потерять: доедут со следующей пачкой
    });
  }
  function addLine(text, speaker) {
    text = fixTerms((text || '').replace(/\s+/g, ' ').trim());
    if (!text) return;
    var line = { t: elapsed(), text: text, speaker: speaker || '' };
    st.lines.push(line);
    st.pending.push(line);
    hook('onLine', line);
    if (st.pending.length >= LINES_BATCH) flushLines();
  }

  // Web Speech в Chrome умеет слушать конкретную дорожку — отдаём ему смикшированную (я + собеседники).
  // Не примет — падаем на дорожку вкладки, в самом худшем случае на системный микрофон.
  // ---- распознавание: на каждую сторону свой движок ----
  // Раньше слушали смикшированную дорожку, и на наложении голосов Web Speech терял куски целыми минутами.
  // Теперь звук вкладки (собеседник) и микрофон (я) идут в РАЗНЫЕ распознаватели: каждый слышит один голос,
  // а в расшифровке видно, кто говорил. Если Chrome не примет дорожку, откатываемся на общий микс.
  function makeAsr(track, speaker) {
    return { track: track, speaker: speaker, sr: null, fails: 0, timer: null, alive: false, dead: false };
  }
  function startOne(rec) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { rec.dead = true; return; }
    if (rec.sr) { rec.sr.onend = null; try { rec.sr.stop(); } catch (e) {} }
    var r = new SR();
    r.lang = 'ru-RU'; r.continuous = true; r.interimResults = true;
    var startedAt = Date.now();
    r.onstart = function () { rec.alive = true; rec.fails = 0; asrBump(); };
    r.onresult = function (e) {
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) addLine(e.results[i][0].transcript, rec.speaker);
        else interim += e.results[i][0].transcript;
      }
      if (interim) hook('onInterim', interim, rec.speaker);
    };
    r.onerror = function (e) {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { rec.dead = true; asrBump(); }
    };
    r.onend = function () {
      rec.alive = false;
      if (!active() || st.stopping || st.paused || rec.dead) return;
      if (Date.now() - startedAt < 1000) rec.fails++; else rec.fails = 0;
      if (rec.fails >= 6) { rec.dead = true; asrBump(); return; }
      rec.timer = setTimeout(function () { if (active() && !st.paused) startOne(rec); }, Math.min(300 * rec.fails, 3000));
    };
    rec.sr = r;
    try { r.start(rec.track); return; } catch (e) {}
    try { r.start(); } catch (e2) { rec.dead = true; asrBump(); }   // дорожку не приняли — системный вход
  }
  function asrBump() {
    var live = st.asrs.filter(function (a) { return a.alive; }).length;
    var dead = st.asrs.length && st.asrs.every(function (a) { return a.dead; });
    st.asrState = dead ? 'распознавание не поднимается' : (live ? 'пишу расшифровку' : 'поднимаю распознавание…');
    hook('onAsr', st.asrState);
  }
  function asrStart() {
    asrStop();
    var tabTrack = st.display ? st.display.getAudioTracks()[0] : null;
    var micTrack = st.mic ? st.mic.getAudioTracks()[0] : null;
    st.asrs = [];
    if (tabTrack) st.asrs.push(makeAsr(tabTrack, 'them'));
    if (micTrack) st.asrs.push(makeAsr(micTrack, 'me'));
    if (!st.asrs.length) {                                   // нечего разделять — слушаем общий микс
      var mix = st.dest ? st.dest.stream.getAudioTracks()[0] : null;
      if (mix) st.asrs.push(makeAsr(mix, ''));
    }
    st.asrs.forEach(startOne);
    asrBump();
  }
  function asrStop() {
    (st.asrs || []).forEach(function (rec) {
      if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
      if (rec.sr) { rec.sr.onend = null; try { rec.sr.stop(); } catch (e) {} rec.sr = null; }
      rec.alive = false;
    });
    st.asrs = [];
    st.asrState = 'off';
  }

  // Профили записи. Захват без ограничений отдаёт полный retina-кадр (замерено на живой встрече: 3356×2836),
  // а vp9 кодируется программно — на созвоне это отбирает процессор у самой встречи, и собеседник рвётся.
  var PROFILES = {
    light: { w: 1280, h: 720, fps: 12, bps: 900000,  codecs: ['vp8', 'vp9'] },
    sharp: { w: 0,    h: 0,   fps: 15, bps: 1600000, codecs: ['vp9', 'vp8'] }
  };
  function profile(name) { return PROFILES[name] || PROFILES.light; }

  function pickMime(codecs) {
    if (!window.MediaRecorder) return '';
    var cands = [];
    (codecs || ['vp8', 'vp9']).forEach(function (c) { cands.push('video/webm;codecs=' + c + ',opus'); });
    cands.push('video/webm');
    for (var i = 0; i < cands.length; i++) {
      if (MediaRecorder.isTypeSupported(cands[i])) return cands[i];
    }
    return '';
  }
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function stopTracks() {
    [st.display, st.mic].forEach(function (s) {
      if (s) s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    });
    st.display = null; st.mic = null; st.mixed = null; st.micLevel = null;
    if (st.ctx) { try { st.ctx.close(); } catch (e) {} st.ctx = null; st.dest = null; }
  }

  // ---- старт ----
  function start(opts) {
    opts = opts || {};
    if (active() || st.starting) return Promise.reject(new Error('запись уже идёт'));
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return Promise.reject(new Error('браузер не умеет захват вкладки (нужен Chrome)'));
    }
    var prof = profile(opts.quality);
    var mime = pickMime(prof.codecs);
    if (!mime) return Promise.reject(new Error('браузер не умеет писать webm'));
    st.starting = true;
    var title = (opts.title || '').trim() || ('Встреча ' + stamp());

    st.seq = 0; st.queue = []; st.busy = false; st.fails = 0; st.sent = 0;
    st.lines = []; st.pending = []; st.stopping = false; st.err = '';
    st.paused = false; st.pauseAt = 0; st.pausedMs = 0;
    loadFixes();   // карта поломок терминов пригодится уже на первой реплике
    setState('выбери вкладку со встречей и включи «Поделиться звуком вкладки»…');

    var videoWant = { frameRate: { ideal: prof.fps, max: prof.fps + 3 } };
    if (prof.w) { videoWant.width = { max: prof.w }; videoWant.height = { max: prof.h }; }

    return navigator.mediaDevices.getDisplayMedia({
      video: videoWant,
      audio: true
    }).then(function (display) {
      st.display = display;
      st.tabAudioOn = display.getAudioTracks().length > 0;
      // Chrome умеет проигнорировать ограничения в самом getDisplayMedia — дожимаем уже на треке
      var vt = display.getVideoTracks()[0];
      if (vt && vt.applyConstraints) { try { vt.applyConstraints(videoWant); } catch (e) {} }
      probeStop();   // проба держала микрофон занятым — освобождаем под саму запись
      // вход не передали (страницу не успели открыть) — подбираем сами, системный по умолчанию бывает немым
      // Выбранный вход проверяем ещё раз: наушники могли переподключиться, а писать встречу в немой
      // микрофон бессмысленно. autoPick начинает как раз с него, поэтому живой вход остаётся на месте.
      var want = withDeadline(
        autoPick(opts.deviceId || null).then(function (r) { return (r && r.deviceId) || opts.deviceId || null; }),
        8000, opts.deviceId || null
      );
      // микрофон не обязателен: отказали в доступе или вход не отвечает — пишем встречу без своей дорожки,
      // но саму встречу не срываем. Дедлайн обязателен: зависший вход иначе утащит с собой весь старт
      return want.then(function (id) {
        return withDeadline(
          navigator.mediaDevices.getUserMedia({ audio: micConstraint(id) }).catch(function () {
            if (!id) return null;
            return navigator.mediaDevices.getUserMedia({ audio: micConstraint(null) }).catch(function () { return null; });
          }),
          6000, null
        );
      });
    }).then(function (mic) {
      st.mic = mic;
      st.micOn = !!(mic && mic.getAudioTracks().length);
      st.micLabel = st.micOn ? (mic.getAudioTracks()[0].label || '') : '';
      st.micLevel = null; st.micLoudAt = Date.now();

      // сводим звук вкладки и микрофон в одну дорожку — на выходе один файл, который просто смотреть
      var audioTracks = [];
      if (st.tabAudioOn || st.micOn) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        st.ctx = new Ctx();
        st.dest = st.ctx.createMediaStreamDestination();
        if (st.tabAudioOn) st.ctx.createMediaStreamSource(st.display).connect(st.dest);
        if (st.micOn) {
          var micSrc = st.ctx.createMediaStreamSource(st.mic);
          micSrc.connect(st.dest);
          st.micLevel = meter(st.ctx, micSrc);   // следим за своей дорожкой отдельно от общей
        }
        audioTracks = st.dest.stream.getAudioTracks();
      }
      st.mixed = new MediaStream(st.display.getVideoTracks().concat(audioTracks));
      return api.createRecording(title, 'video/webm');
    }).then(function (res) {
      st.id = res.id; st.file = res.file;
      st.startedAt = Date.now();

      var r = new MediaRecorder(st.mixed, { mimeType: mime, videoBitsPerSecond: prof.bps, audioBitsPerSecond: AUDIO_BPS });
      r.ondataavailable = function (e) { enqueue(e.data); };
      r.onerror = function (e) { setState('сбой записи: ' + ((e && e.error && e.error.name) || '?'), 'err'); };
      st.rec = r;
      r.start(CHUNK_MS);

      // юзер нажал «Остановить доступ» в плашке Chrome — заканчиваем корректно, а не пишем чёрный экран
      var vt = st.display.getVideoTracks()[0];
      if (vt) vt.onended = function () { if (active()) stop(); };
      var vs = (vt && vt.getSettings) ? vt.getSettings() : {};
      st.videoInfo = (vs.width || '?') + '×' + (vs.height || '?') + '@' + Math.round(vs.frameRate || 0) + 'fps';

      asrStart();   // расшифровка идёт всегда: собеседник и я — двумя отдельными распознавателями
      if (st.linesTimer) clearInterval(st.linesTimer);
      st.linesTimer = setInterval(flushLines, LINES_EVERY);

      var warn = [];
      if (!st.tabAudioOn) warn.push('без звука вкладки — забыл галочку «Поделиться звуком вкладки»');
      if (!st.micOn) warn.push('без микрофона — доступ не дали');
      setState(warn.length ? 'пишу, но ' + warn.join('; ') : 'пишу встречу', warn.length ? 'warn' : 'live');
      st.starting = false;
      hook('onStart', { id: st.id, title: title, startedAt: st.startedAt });
      return { id: st.id };
    }).catch(function (e) {
      stopTracks();
      st.rec = null; st.starting = false;
      // строку в БД уже завели, а писать не начали — закрываем её, иначе висит вечным «идёт запись»
      if (st.id) { api.finishRecording(st.id, 0).catch(function () {}); st.id = null; }
      var msg = (e && e.name === 'NotAllowedError') ? 'захват отменён' : ((e && e.message) || 'не удалось начать запись');
      setState(msg, 'err');
      throw new Error(msg);
    });
  }

  // ---- пауза: файл не растёт, распознавание молчит, таймер стоит ----
  function pause() {
    if (!active() || st.paused || st.stopping) return false;
    try { st.rec.pause(); } catch (e) { return false; }
    st.paused = true;
    st.pauseAt = Date.now();
    asrStop();          // на паузе речь в расшифровку не пишем
    flushLines();
    setState('пауза — запись стоит', 'warn');
    hook('onPause', true);
    return true;
  }
  function resume() {
    if (!active() || !st.paused || st.stopping) return false;
    try { st.rec.resume(); } catch (e) { return false; }
    st.pausedMs += Date.now() - st.pauseAt;
    st.pauseAt = 0;
    st.paused = false;
    st.micLoudAt = Date.now();   // после паузы даём микрофону фору, иначе сразу крикнет «молчит»
    asrStart();
    setState('пишу встречу', 'live');
    hook('onPause', false);
    return true;
  }

  // ---- стоп: дописать хвост, дослать очередь и расшифровку, закрыть запись на сервере ----
  function stop() {
    if (!active() || st.stopping) return Promise.resolve(null);
    st.stopping = true;
    var id = st.id, dur = elapsed();
    setState('дописываю хвост записи…');
    var r = st.rec;
    return new Promise(function (resolve) {
      var done = false;
      r.onstop = function () { if (!done) { done = true; resolve(); } };
      try { r.stop(); } catch (e) { if (!done) { done = true; resolve(); } }
      setTimeout(function () { if (!done) { done = true; resolve(); } }, 4000);
    }).then(function () {
      st.rec = null;
      st.paused = false; st.pauseAt = 0;
      asrStop();
      if (st.linesTimer) { clearInterval(st.linesTimer); st.linesTimer = null; }
      stopTracks();
      setState('доливаю на сервер…');
      return flushQueue(60000);
    }).then(function (allSent) {
      return flushLines().then(function () { return allSent; });
    }).then(function (allSent) {
      return api.finishRecording(id, dur).then(function (res) {
        st.id = null; st.stopping = false;
        setState(allSent ? 'запись сохранена' : 'сохранено, но часть кусков не долилась', allSent ? '' : 'err');
        hook('onStop', { id: id, ok: !!allSent, status: res && res.status });
        return res;
      });
    }).catch(function (e) {
      st.id = null; st.stopping = false; st.rec = null;
      setState('не удалось закрыть запись: ' + ((e && e.message) || '?'), 'err');
      hook('onStop', { id: id, ok: false });
      return null;
    });
  }

  // уровень микрофона тикает часто (полоска), счётчики — раз в секунду
  var silentWarned = false, lastTick = 0;
  setInterval(function () {
    if (!active()) return;
    var now = Date.now();
    if (st.micLevel && !st.paused) {
      var lvl = st.micLevel();
      hook('onMicLevel', { level: lvl, live: true });
      if (lvl >= SILENT_RMS) { st.micLoudAt = now; silentWarned = false; }
      else if (!silentWarned && now - st.micLoudAt > SILENT_WARN_MS) {
        silentWarned = true;
        setState('микрофон молчит — тебя не слышно. Выбери другой вход в списке выше', 'err');
      }
    }
    if (now - lastTick < 1000) return;
    lastTick = now;
    hook('onTick', {
      ms: elapsed(),
      paused: st.paused,
      queue: st.queue.length,
      sent: st.sent,
      lines: st.lines.length,
      micOn: st.micOn,
      err: st.err
    });
  }, 200);

  window.addEventListener('beforeunload', function (e) {
    if (!active()) return;
    e.preventDefault();
    e.returnValue = '';   // идёт запись — закрытие вкладки её оборвёт
  });

  SOBES.rec = {
    start: start,
    stop: stop,
    pause: pause,
    resume: resume,
    paused: function () { return st.paused; },
    active: active,
    stream: function () { return st.mixed; },
    mics: listMics,
    autoPick: autoPick,
    probe: probeStart,
    probeStop: probeStop,
    info: function () {
      return {
        id: st.id, startedAt: st.startedAt, paused: st.paused, queue: st.queue.length, sent: st.sent,
        lines: st.lines.length, micOn: st.micOn, micLabel: st.micLabel,
        tabAudioOn: st.tabAudioOn, video: st.videoInfo, asr: st.asrState,
        asrCount: st.asrs.length, asrLive: st.asrs.filter(function (a) { return a.alive; }).length
      };
    }
  };
})();
