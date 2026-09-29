#!/usr/bin/env python3
"""Мост суфлёра на подписку Claude (без API-ключа).

Хостовый сервис под launchd (com.sobes.bridge): принимает от php тот же payload,
что уходил в Anthropic Messages API, и отвечает SSE в том же формате — php
(`anthropicStream()`) разницы не видит. Внутри — пул заранее прогретых процессов
`claude -p --input-format stream-json`, авторизованных OAuth-токеном подписки
(CLAUDE_CODE_OAUTH_TOKEN из ~/.config/sobes/env, кладётся `claude setup-token`).

Почему так (ресёрч 29.09.2026, замеры в сессии sobes):
- прогретый процесс отдаёт первый токен за ~1с; холодный старт CLI ~1с сверху,
  поэтому пул прогревается заранее, а замена уходящего процесса — в фоне;
- контекст в процессе копится (428→880 токенов за 3 вопроса) и история чужих
  вопросов не нужна следующему — процесс отвечает РОВНО НА ОДИН вопрос и уходит;
- system-промпт у CLI фиксируется на старте процесса, а у суфлёра он на каждый
  запрос свой (RAG-карточки) — поэтому system+история+вопрос склеиваются в одно
  user-сообщение (Haiku формат держит);
- картинки (/vision) проходят стандартными image-блоками — проверено;
- обрыв клиента → control_request {subtype: interrupt}: генерация встаёт сразу;
- `--bare` НЕ используем: он игнорирует OAuth и требует API-ключ.

Слушает 0.0.0.0 (docker до 127.0.0.1 мака не достаёт), поэтому каждый запрос
обязан нести BRIDGE_SECRET (тот же ~/.config/sobes/env) в заголовке x-api-key —
php и так его шлёт. Без секрета — 401, чтобы соседи по Wi-Fi не жгли подписку.
"""
import json, os, re, secrets as pysecrets, signal, subprocess, sys, threading, time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 47391
ENV_FILE = os.path.expanduser('~/.config/sobes/env')
CWD = os.path.expanduser('~/.config/sobes/bridge-home')  # пустая папка: чтобы CLI не подхватил чей-нибудь CLAUDE.md
CLAUDE = os.path.expanduser('~/.local/bin/claude')
POOL_SIZE = {'haiku': 2, 'sonnet': 1}   # /ask (основной+спекулятивный) и /vision
TTFT_S = 30      # нет первого токена — считаем запрос мёртвым
TOTAL_S = 110    # потолок на весь ответ (< request_terminate_timeout 120с в fpm)
IDLE_RETIRE_S = 6 * 3600  # процесс старше 6ч без дела — заменить (протухшие соединения)

def log(*a):
    print(time.strftime('%H:%M:%S'), *a, file=sys.stderr, flush=True)

def env_vars():
    v = {}
    try:
        with open(ENV_FILE) as f:
            for line in f:
                m = re.match(r'^\s*([A-Z_]+)\s*=\s*(.+?)\s*$', line)
                if m: v[m.group(1)] = m.group(2).strip('"\'')
    except OSError:
        pass
    return v

def family(model):
    for fam in ('haiku', 'sonnet', 'opus'):
        if fam in (model or ''): return fam
    return 'haiku'

class Proc:
    """Один процесс claude = один ответ. После ответа — на пенсию."""
    def __init__(self, fam):
        self.fam = fam
        self.born = time.time()
        env = {
            'HOME': os.path.expanduser('~'),
            'PATH': os.path.dirname(CLAUDE) + ':/usr/bin:/bin',
            'TERM': 'dumb', 'LANG': 'en_US.UTF-8',
            # без этого node пробует IPv6-адрес Anthropic первым и ждёт его ~1-1.5с на каждом запросе
            'NODE_OPTIONS': '--dns-result-order=ipv4first',
            # выключить «раздумья»: на промпте суфлёра Haiku думал 300-400 токенов и первый
            # видимый токен приходил через 4-6с вместо 0.6с (замер 29.09.2026); в API-версии
            # суфлёра тоже стояло thinking: disabled
            'MAX_THINKING_TOKENS': '0',
            'CLAUDE_CODE_OAUTH_TOKEN': env_vars().get('CLAUDE_CODE_OAUTH_TOKEN', ''),
        }
        self.p = subprocess.Popen(
            [CLAUDE, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
             '--include-partial-messages', '--verbose', '--model', fam,
             '--tools', '', '--strict-mcp-config', '--setting-sources', '',
             '--no-session-persistence'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1, cwd=CWD, env=env)

    def alive(self): return self.p.poll() is None

    def kill(self):
        try:
            self.p.stdin.close()
        except OSError:
            pass
        self.p.terminate()

POOL = {fam: deque() for fam in POOL_SIZE}
LOCK = threading.Lock()

def refill():
    for fam, n in POOL_SIZE.items():
        with LOCK:
            POOL[fam] = deque(pr for pr in POOL[fam] if pr.alive() and time.time() - pr.born < IDLE_RETIRE_S)
            need = n - len(POOL[fam])
        for _ in range(max(0, need)):
            pr = Proc(fam)
            with LOCK:
                POOL[fam].append(pr)
            log('прогрет', fam, 'pid', pr.p.pid)

def take(fam):
    # refill здесь НЕ зовём: node-старт нового claude (~1с CPU) конкурировал бы с отвечающим
    # процессом и добавлял 1-3с к первому токену (замер 29.09.2026) — пул пополняется после ответа
    with LOCK:
        q = POOL.get(fam)
        pr = q.popleft() if q else None
    if pr and pr.alive(): return pr
    log('пул пуст, холодный старт', fam)
    return Proc(fam)

def flatten(payload):
    """system + история + вопрос → одно user-сообщение (system у CLI не пер-запросный)."""
    parts, images = [], []
    if payload.get('system'): parts.append(str(payload['system']))
    msgs = payload.get('messages') or []
    hist = msgs[:-1]
    if hist:
        lines = ['Предыдущие реплики этой беседы (контекст для уточнений):']
        for m in hist:
            role = 'Вопрос' if m.get('role') == 'user' else 'Твой ответ'
            if isinstance(m.get('content'), str): lines.append(f"{role}: {m['content']}")
        parts.append('\n'.join(lines))
    last = msgs[-1] if msgs else {}
    c = last.get('content')
    if isinstance(c, str):
        parts.append('Текущий вопрос: ' + c)
    elif isinstance(c, list):
        for b in c:
            if b.get('type') == 'image': images.append(b)
            elif b.get('type') == 'text': parts.append(b.get('text', ''))
    return images + [{'type': 'text', 'text': '\n\n'.join(p for p in parts if p)}]

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass

    def _sse(self, obj):
        self.wfile.write(('data: ' + json.dumps(obj, ensure_ascii=False) + '\n\n').encode())
        self.wfile.flush()

    def do_GET(self):
        if self.path == '/health':
            with LOCK:
                body = json.dumps({fam: len(q) for fam, q in POOL.items()}).encode()
            self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != '/v1/messages':
            return self.send_error(404)
        if self.headers.get('x-api-key', '') != env_vars().get('BRIDGE_SECRET', '\0'):
            return self.send_error(401)
        try:
            payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        except (ValueError, TypeError):
            return self.send_error(400)

        fam = family(payload.get('model'))
        log(fam, 'запрос принят,', len(json.dumps(payload)), 'байт payload')
        pr = take(fam)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True   # конец стрима = закрытие сокета, иначе php-curl ждёт EOF до таймаута

        t0 = time.time(); sent = False; err = None; ttft = None; twr = None; tfl = None
        try:
            pr.p.stdin.write(json.dumps(
                {'type': 'user', 'message': {'role': 'user', 'content': flatten(payload)}},
                ensure_ascii=False) + '\n')
            pr.p.stdin.flush()
            twr = round(time.time() - t0, 2)
            while True:
                if time.time() - t0 > (TOTAL_S if sent else TTFT_S):
                    err = 'мост: таймаут ответа claude'; break
                line = pr.p.stdout.readline()
                if tfl is None and line: tfl = round(time.time() - t0, 2)
                if not line:
                    err = 'мост: процесс claude умер (токен подписки истёк? см. sobes-bridge.log)'; break
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get('type') == 'stream_event':
                    d = ev.get('event', {})
                    if d.get('type') == 'content_block_delta' and d.get('delta', {}).get('type') == 'text_delta':
                        if ttft is None: ttft = round(time.time() - t0, 2)
                        self._sse({'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': d['delta']['text']}})
                        sent = True
                elif ev.get('type') == 'result':
                    if ev.get('is_error'):
                        msg = str(ev.get('result') or ev.get('subtype') or 'ошибка claude')[:400]
                        if re.search(r'limit|quota', msg, re.I):
                            msg = 'лимит подписки Claude исчерпан (окно 5ч) — ' + msg
                        err = msg
                    break
        except BrokenPipeError:
            # клиент ушёл (php поймал обрыв браузера) — глушим генерацию и хороним процесс
            try:
                pr.p.stdin.write(json.dumps({'type': 'control_request', 'request_id': 'x',
                                             'request': {'subtype': 'interrupt'}}) + '\n')
                pr.p.stdin.flush()
            except OSError:
                pass
            log(fam, 'клиент оборвал стрим на', round(time.time() - t0, 1), 'с')
        except OSError as e:
            err = 'мост: ' + str(e)
        finally:
            pr.kill()   # один процесс = один ответ
            threading.Thread(target=refill, daemon=True).start()   # замену греем ПОСЛЕ ответа

        if err:
            log(fam, 'ошибка:', err)
            try:
                self._sse({'type': 'error', 'error': {'type': 'api_error', 'message': err}})
            except OSError:
                pass
        else:
            log(fam, 'ответ за', round(time.time() - t0, 1), 'с: записали вопрос', twr, 'с, первая строка от claude', tfl, 'с, первый токен', ttft, 'с, возраст процесса', round(time.time() - pr.born), 'с')

def main():
    os.makedirs(CWD, exist_ok=True)
    if not env_vars().get('CLAUDE_CODE_OAUTH_TOKEN'):
        log('нет CLAUDE_CODE_OAUTH_TOKEN в', ENV_FILE, '— выполни `claude setup-token`'); sys.exit(1)
    if not env_vars().get('BRIDGE_SECRET'):
        with open(ENV_FILE, 'a') as f:
            f.write('BRIDGE_SECRET=' + pysecrets.token_hex(24) + '\n')
        log('сгенерирован BRIDGE_SECRET')
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    refill()
    log('мост слушает :', PORT)
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()

if __name__ == '__main__':
    main()
