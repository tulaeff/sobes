#!/usr/bin/env python3
"""Точная расшифровка записей встреч локальным whisper.cpp.

Живёт на ХОСТЕ, а не в контейнере: whisper считает на процессоре машины (в докере на маке
он всё равно был бы без ускорения), и модели лежат в домашней папке.

Забирает очередь из API (`GET /transcribe/queue`), гоняет ffmpeg + whisper-cli
и заливает реплики обратно взамен черновой расшифровки из браузера.

    python3 scripts/whisper_transcribe.py            # разово: разобрать всю очередь
    python3 scripts/whisper_transcribe.py --watch    # крутиться и подхватывать новые
"""

import json
import os
import re
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.request

API = os.environ.get('SOBES_API', 'https://sobes.local/api')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REC_DIR = os.environ.get('SOBES_REC_DIR', os.path.join(ROOT, 'recordings'))
MODEL = os.environ.get('WHISPER_MODEL', os.path.expanduser('~/.cache/whisper-models/ggml-large-v3-turbo.bin'))
# VAD вырезает тишину ДО распознавания. Без него модель на тихих участках уходит в бесконечный повтор:
# поймано на живой встрече — 18 минут аудио сожгли 5 часов процессорного времени и так и не закончились.
VAD_MODEL = os.environ.get('WHISPER_VAD_MODEL', os.path.expanduser('~/.cache/whisper-models/ggml-silero-v5.1.2.bin'))
THREADS = os.environ.get('WHISPER_THREADS', '8')       # не все ядра: машина должна оставаться живой
BATCH = 200                                            # реплик в одном запросе
PART_SEC = 480                                         # режем аудио на куски по 8 минут
PART_TIMEOUT_X = 3                                     # потолок на кусок: 3× его длительности
CA = os.path.expanduser('~/Library/Application Support/mkcert/rootCA.pem')

# whisper на тишине любит выдавать закадровые пометки — в расшифровке они мусор
JUNK = re.compile(r'^[\s\[\(]*(blank_audio|музыка|аплодисменты|тишина|subtitles|продолжение следует)[\s\]\)\.]*$', re.I)

ctx = ssl.create_default_context(cafile=CA if os.path.exists(CA) else None)


def api(path, method='GET', body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, context=ctx, timeout=180) as r:
        raw = r.read().decode()
    return json.loads(raw) if raw else None


def say(msg):
    print(time.strftime('%H:%M:%S'), msg, flush=True)


def set_status(rec_id, status, note=''):
    try:
        api('/recordings/%s/transcribe' % rec_id, 'PATCH', {'status': status, 'note': note})
    except Exception as e:
        say('не смог обновить статус %s: %s' % (rec_id, e))


def audio_seconds(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'default=noprint_wrappers=1:nokey=1', path],
                         capture_output=True, text=True, check=True)
    return float(out.stdout.strip() or 0)


def whisper_part(wav, out, limit):
    """Один кусок. `-mc 0` не тащит контекст между окнами — именно перенос контекста загоняет модель
    в бесконечный повтор на тихих участках (поймано на живой встрече: 5 часов CPU вместо 11 минут).
    Таймаут — последний рубеж: зависший кусок убиваем, а не ждём сутки."""
    # `-bs 1` (greedy вместо beam search по 5 лучам) — главный рычаг: замерено на живой встрече, тот же
    # восьмиминутный кусок с beam search висел 25 минут и был убит по таймауту ДВАЖДЫ, а с greedy посчитался
    # за 2:46. Beam search на длинной русской речи и залипает, и тормозит; качество текста при этом сопоставимо.
    cmd = ['whisper-cli', '-m', MODEL, '-l', 'ru', '-t', THREADS, '-mc', '0', '-et', '2.8', '-bs', '1',
           '-oj', '-of', out, '-f', wav]
    if os.path.isfile(VAD_MODEL):
        cmd += ['--vad', '--vad-model', VAD_MODEL]
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        code = p.wait(timeout=limit)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
        raise TimeoutError('whisper завис (дольше %d с)' % limit)
    if code != 0:
        raise RuntimeError('whisper вернул код %s' % code)
    with open(out + '.json', encoding='utf-8') as f:
        data = json.load(f)
    lines = []
    for seg in data.get('transcription', []):
        text = (seg.get('text') or '').strip()
        if not text or JUNK.match(text):
            continue
        lines.append({'t': int((seg.get('offsets') or {}).get('from', 0)), 'text': text})
    return lines


def run_whisper(src, work):
    """webm → wav 16кГц моно → whisper по кускам → список реплик [{t, text}].
    Режем на куски, чтобы залипание на одном участке не утаскивало весь прогон и было видно прогресс."""
    wav = os.path.join(work, 'audio.wav')
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000',
                    '-c:a', 'pcm_s16le', wav], check=True)
    total = audio_seconds(wav)
    lines, start, idx, lost = [], 0, 0, 0
    while start < total:
        part = os.path.join(work, 'part%d.wav' % idx)
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-ss', str(start), '-t', str(PART_SEC),
                        '-i', wav, '-c', 'copy', part], check=True)
        span = min(PART_SEC, total - start)
        try:
            segs = whisper_part(part, os.path.join(work, 'out%d' % idx), int(span * PART_TIMEOUT_X) + 60)
            for s in segs:
                s['t'] += int(start * 1000)
            lines += segs
        except (TimeoutError, RuntimeError) as e:
            lost += 1
            say('  кусок %d (%d:%02d) не дался: %s' % (idx, start // 60, start % 60, e))
        start += PART_SEC
        idx += 1
    if lost:
        say('  кусков потеряно: %d из %d' % (lost, idx))
    return lines


def fix_terms(segments):
    """Тот же словарь поломок, что и у живой расшифровки. Whisper ломает термины по-своему
    («бэков» вместо backoff, «промэтис» вместо Prometheus), но так же однозначно."""
    try:
        fixes = (api('/asr-terms') or {}).get('fixes') or {}
    except Exception:
        return segments
    if not fixes:
        return segments
    rules = []
    for k in sorted(fixes, key=len, reverse=True):          # длинные ключи первыми
        rules.append((re.compile(r'(^|[^0-9a-zA-Zа-яёА-ЯЁ])' + re.escape(k) + r'(?![0-9a-zA-Zа-яёА-ЯЁ])', re.I), fixes[k]))
    for s in segments:
        text = s['text']
        for rx, to in rules:
            text = rx.sub(lambda m, to=to: m.group(1) + to, text)
        s['text'] = text
    return segments


def assign_speakers(segments, live):
    """Whisper говорящих не различает, а черновая расшифровка из браузера — различает (у неё на каждую
    сторону свой распознаватель). Поэтому переносим метки: браузерная реплика записана в момент, когда
    фраза ДОГОВОРЕНА, поэтому её условное начало прикидываем по числу слов."""
    marked = [l for l in live if l.get('speaker')]
    if not marked:
        return segments
    spans = []
    for l in marked:
        words = max(1, len((l.get('text') or '').split()))
        end = int(l.get('t') or 0)
        spans.append((max(0, end - words * 350), end, l['speaker']))
    for s in segments:
        t, best, best_d = s['t'], '', 10 ** 9
        for start, end, who in spans:
            if start <= t <= end:
                best, best_d = who, 0
                break
            d = min(abs(t - start), abs(t - end))
            if d < best_d:
                best, best_d = who, d
        s['speaker'] = best if best_d <= 20000 else ''    # дальше 20с от любой реплики — честнее без метки
    return segments


def upload(rec_id, lines):
    """Первая пачка идёт с replace — она вытесняет черновую расшифровку из браузера."""
    if not lines:
        api('/recordings/%s/lines' % rec_id, 'POST', {'lines': [], 'replace': True, 'kind': 'whisper'})
        return 0
    sent = 0
    for i in range(0, len(lines), BATCH):
        chunk = lines[i:i + BATCH]
        api('/recordings/%s/lines' % rec_id, 'POST',
            {'lines': chunk, 'replace': i == 0, 'kind': 'whisper'})
        sent += len(chunk)
    return sent


def handle(rec):
    rec_id = rec['id']
    src = os.path.join(REC_DIR, rec['file'])
    if not os.path.isfile(src):
        set_status(rec_id, 'failed', 'файла нет на диске')
        say('#%s: файла нет — %s' % (rec_id, src))
        return
    minutes = round((rec.get('durationMs') or 0) / 60000, 1)
    say('#%s «%s» (%s мин) — расшифровываю' % (rec_id, rec.get('title', ''), minutes))
    set_status(rec_id, 'running', 'считаю…')
    t0 = time.time()
    try:
        live = []
        try:
            live = (api('/recordings/%s' % rec_id) or {}).get('lines', [])   # метки говорящих забираем ДО замены
        except Exception as e:
            say('#%s: не смог прочитать черновую расшифровку (%s) — залью без разделения' % (rec_id, e))
        with tempfile.TemporaryDirectory() as work:
            lines = run_whisper(src, work)
        lines = assign_speakers(fix_terms(lines), live)
        n = upload(rec_id, lines)
        took = round(time.time() - t0)
        note = '%d реплик · %s · %d:%02d' % (n, os.path.basename(MODEL), took // 60, took % 60)
        set_status(rec_id, 'done', note)
        say('#%s: готово — %s' % (rec_id, note))
    except subprocess.CalledProcessError as e:
        set_status(rec_id, 'failed', 'ffmpeg/whisper вернул ошибку')
        say('#%s: упал внешний процесс: %s' % (rec_id, e))
    except Exception as e:
        set_status(rec_id, 'failed', str(e)[:200])
        say('#%s: ошибка: %s' % (rec_id, e))


def recording_now():
    """Идёт ли прямо сейчас запись встречи. Пока идёт — не считаем: whisper съест процессор,
    из-за которого на созвоне начинает рвать собеседника."""
    try:
        return any(r.get('status') == 'recording' for r in (api('/recordings') or []))
    except Exception:
        return False


def once():
    queue = api('/transcribe/queue') or []
    if not queue:
        return 0
    if recording_now():
        say('идёт запись — откладываю расшифровку (%d в очереди)' % len(queue))
        return 0
    for rec in queue:
        handle(rec)
        if recording_now():                 # встречу начали посреди очереди — дальше подождём
            say('началась запись — остальное доделаю позже')
            break
    return len(queue)


def main():
    if not os.path.isfile(MODEL):
        say('нет модели: %s' % MODEL)
        sys.exit(1)
    if '--watch' in sys.argv:
        say('жду записи в очереди (%s)' % API)
        while True:
            try:
                once()
            except Exception as e:
                say('очередь недоступна: %s' % e)
            time.sleep(20)
    else:
        n = once()
        say('в очереди было: %d' % n)


if __name__ == '__main__':
    main()
