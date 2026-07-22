<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

const CACHE_KEY = 'sobes:cards';
// Запросы к Anthropic идут через локальный nginx (docker/site.conf, порт 8081): он держит keepalive-пул,
// поэтому TCP+TLS (350-450мс) не платятся на каждом вопросе. Прокси лёг — код сам уходит на прямой адрес.
const ANTHROPIC_URL = 'http://sobes-web:8081/anthropic/v1/messages';
const ANTHROPIC_URL_DIRECT = 'https://api.anthropic.com/v1/messages';
// модель AI-суфлёра. Быстрая/дешёвая — haiku (для живого суфлёра). Умнее/медленнее: claude-sonnet-5, claude-opus-4-8.
const ASK_MODEL = 'claude-haiku-4-5';
// модель разбора скрина (vision): sonnet-5 — сильна по коду; можно claude-opus-4-8 для сложных задач.
const VISION_MODEL = 'claude-sonnet-5';

// Вопрос приходит из распознавания речи (ru-RU), английские термины оно ломает под созвучные русские слова.
// Даём модели примеры поломок и канонический словарь стека, чтобы она восстанавливала смысл сама.
const ASR_HINT = "\n\nВАЖНО ПРО ВХОД: вопрос — это сырая расшифровка речи, распознавание русское, и английские термины оно коверкает под похожие русские слова. "
    . "Реальные поломки: «ларавель жопа»=Laravel jobs, «оп»=ООП, «кофта»=Kafka, «губер нет тест»=Kubernetes, «редис»=Redis, «постгрес»=PostgreSQL, «майскл»=MySQL, "
    . "«кролик»/«раббит»=RabbitMQ, «элоквент»=Eloquent, «композер»=Composer, «клоужер»=closure, «мидлвар»=middleware, «опкеш»=OPcache, «дедлок»=deadlock, "
    . "«джойн»=join, «аутбокс»=outbox, «хендлер»=handler, «воркер»=worker, «ретрай»=retry, «неймспейс»=namespace, «джоба»/«жоба»=job, «асид»=ACID, «оауф»=OAuth, «корс»=CORS.\n"
    . "Кандидат — PHP-разработчик, вопросы почти всегда про: PHP, Laravel, Eloquent, Symfony, Doctrine, Composer, PSR, PHPUnit, OPcache, "
    . "PostgreSQL, MySQL, Redis, Memcached, Elasticsearch, RabbitMQ, Kafka, очереди, джобы, воркеры, "
    . "Docker, Kubernetes, nginx, Linux, Git, CI/CD, REST, GraphQL, gRPC, protobuf, WebSocket, webhook, JWT, OAuth, CORS, HTTP, "
    . "ООП, SOLID, DDD, CQRS, event sourcing, saga, outbox, идемпотентность, ACID, MVCC, deadlock, транзакции, уровни изоляции, индексы, B-tree, "
    . "шардинг, репликация, партиционирование, N+1, race condition, rate limit, backoff, retry, timeout, at-least-once, exactly-once, "
    . "DI, IoC, middleware, namespace, autoload, trait, closure, generator, yield, TDD, моки, микросервисы, монолит, финтех и платежи, "
    . "JavaScript, TypeScript, Vue, Node.js.\n"
    . "Восстанавливай искажённый термин по смыслу и контексту разговора и отвечай уже по восстановленному вопросу — НЕ переспрашивай и не упоминай, что текст был искажён. "
    . "Но не выдумывай термин там, где его нет: если фраза осмысленна и без правки, понимай её буквально.";

// ---------- подключения ----------
function db(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $host = getenv('PGHOST') ?: 'postgres';
        $name = getenv('PGDATABASE') ?: 'sobes';
        $pdo = new PDO(
            "pgsql:host=$host;port=5432;dbname=$name",
            getenv('PGUSER') ?: 'sobes',
            getenv('PGPASSWORD') ?: 'sobes',
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
        );
    }
    return $pdo;
}

// Redis не критичен: если недоступен — просто работаем без кэша
function redis(): ?Redis {
    static $r = false;
    if ($r === false) {
        try {
            $r = new Redis();
            $r->connect(getenv('REDIS_HOST') ?: 'redis', 6379, 1.0);
        } catch (Throwable $e) {
            $r = null;
        }
    }
    return $r ?: null;
}

function cacheGet(): ?string {
    try { $r = redis(); if ($r) { $v = $r->get(CACHE_KEY); return $v === false ? null : $v; } } catch (Throwable $e) {}
    return null;
}
function cacheSet(string $json): void {
    try { $r = redis(); if ($r) $r->set(CACHE_KEY, $json); } catch (Throwable $e) {}
}
function cacheBust(): void {
    try { $r = redis(); if ($r) $r->del(CACHE_KEY); } catch (Throwable $e) {}
}

// Ключ Anthropic: из env-переменной контейнера или из примонтированного секрет-файла (вне репозитория)
function anthropicKey(): ?string {
    $k = getenv('ANTHROPIC_API_KEY');
    if ($k) return trim($k);
    $f = '/var/www/secret.env';
    $found = null;
    if (is_file($f)) {
        foreach (file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            if (preg_match('/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)$/', $line, $m)) {
                $found = trim($m[1], " \t\"'"); // последняя строка выигрывает (свежедописанный ключ)
            }
        }
    }
    return $found;
}

// стримит ответ Anthropic по SSE прямо в тело HTTP-ответа (text/event-stream — не буферизуется nginx). Завершает запрос.
function anthropicStream(string $payload, string $key): void {
    header('Content-Type: text/event-stream; charset=utf-8');
    header('X-Accel-Buffering: no');
    header('Cache-Control: no-cache');
    while (ob_get_level() > 0) { ob_end_flush(); }

    $buf = '';
    $sent = false;                       // отдали ли клиенту хоть кусок текста — после этого ретраить уже нельзя
    $write = function ($c, $data) use (&$buf, &$sent) {
        $buf .= $data;
        while (($nl = strpos($buf, "\n")) !== false) {
            $line = trim(substr($buf, 0, $nl));
            $buf = substr($buf, $nl + 1);
            if ($line === '' || strncmp($line, 'data:', 5) !== 0) continue;
            $ev = json_decode(trim(substr($line, 5)), true);
            if (!is_array($ev)) continue;
            if (($ev['type'] ?? '') === 'content_block_delta' && ($ev['delta']['type'] ?? '') === 'text_delta') {
                echo $ev['delta']['text']; $sent = true; flush();
            } elseif (($ev['type'] ?? '') === 'error') {
                echo "\n[ошибка Anthropic: " . ($ev['error']['message'] ?? '?') . ']'; $sent = true; flush();
            }
        }
        return strlen($data);
    };
    $run = function (string $url) use ($payload, $key, $write, &$buf) {
        $buf = '';
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST       => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_TIMEOUT    => 90,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_HTTPHEADER => [
                'content-type: application/json',
                'x-api-key: ' . $key,
                'anthropic-version: 2023-06-01',
            ],
            CURLOPT_WRITEFUNCTION => $write,
        ]);
        curl_exec($ch);
        $r = [(int)curl_getinfo($ch, CURLINFO_HTTP_CODE), curl_error($ch), curl_errno($ch)];
        curl_close($ch);
        return $r;
    };

    [$code, $curlErr, $errno] = $run(ANTHROPIC_URL);
    // локальный прокси не поднялся/лёг — уходим напрямую, но только пока клиенту ничего не ушло
    $connFail = in_array($errno, [CURLE_COULDNT_CONNECT, CURLE_COULDNT_RESOLVE_HOST, CURLE_GOT_NOTHING, CURLE_RECV_ERROR, CURLE_SEND_ERROR], true);
    if (!$sent && ($connFail || $code === 502 || $code === 504)) {
        error_log('sobes: keepalive-прокси недоступен (errno=' . $errno . ', code=' . $code . '), иду напрямую');
        [$code, $curlErr, $errno] = $run(ANTHROPIC_URL_DIRECT);
    }
    // ошибка ДО стрима (напр. 401): тело — обычный JSON, а не SSE — оно осталось в $buf
    if ($code >= 400) {
        $e = json_decode($buf, true);
        echo "\n[ошибка Anthropic " . $code . ': ' . ($e['error']['message'] ?? $curlErr) . ']';
    } elseif ($curlErr !== '') {
        echo "\n[сеть: " . $curlErr . ']';
    }
    exit;
}

// ---------- сборка полезной нагрузки ----------
function buildPayload(): string {
    $pdo = db();
    $cats = $pdo->query('SELECT key, title FROM categories ORDER BY sort_order')->fetchAll();
    $rows = $pdo->query(
        'SELECT q.id, q.category_key AS cat, c.title AS "catTitle", q.q, q.a, q.detail, q.code,
                q.tags, q.weight, q.pinned, q.edited
         FROM questions q JOIN categories c ON c.key = q.category_key
         ORDER BY c.sort_order, q.weight DESC, q.id'
    )->fetchAll();

    $items = array_map(static function (array $r): array {
        return [
            'id'       => (string)$r['id'],
            'cat'      => $r['cat'],
            'catTitle' => $r['catTitle'],
            'q'        => $r['q'],
            'a'        => $r['a'],
            'detail'   => $r['detail'],
            'code'     => $r['code'],
            'tags'     => json_decode($r['tags'] ?: '[]', true),
            'weight'   => (int)$r['weight'],
            'pinned'   => (bool)$r['pinned'],
            'edited'   => (bool)$r['edited'],
        ];
    }, $rows);

    $personal = [];
    foreach ($pdo->query("SELECT key, value FROM settings WHERE key IN ('self','task','jobs','ask')") as $s) {
        $personal[$s['key']] = json_decode($s['value'], true);
    }

    return json_encode(['categories' => $cats, 'items' => $items, 'personal' => $personal],
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

// профиль кандидата для суфлёра: кто он, где работал, показательная задача.
// Тексты в settings написаны под конкретную вакансию («ваш продукт»), поэтому в промпте это оговорено.
function candidateProfile(): string {
    static $cached = null;
    if ($cached !== null) return $cached;
    $parts = [];
    try {
        $rows = db()->query("SELECT key, value FROM settings WHERE key IN ('self','jobs','task')")->fetchAll();
    } catch (Throwable $e) {
        return $cached = '';
    }
    $titles = ['self' => 'О себе', 'jobs' => 'Места работы', 'task' => 'Показательная задача из опыта'];
    $order  = ['self', 'jobs', 'task'];
    $byKey  = [];
    foreach ($rows as $r) {
        $v = json_decode($r['value'], true);
        $body = trim((string)($v['body'] ?? ''));
        if ($body !== '') $byKey[$r['key']] = mb_substr($body, 0, 1400);
    }
    foreach ($order as $k) {
        if (isset($byKey[$k])) $parts[] = '## ' . $titles[$k] . "\n" . $byKey[$k];
    }
    if (!$parts) return $cached = '';

    return $cached = "\n\nПРОФИЛЬ КАНДИДАТА, за которого ты суфлируешь (это ЕГО факты, не твои):\n"
        . implode("\n\n", $parts)
        . "\n\nОтвечай ОТ ЕГО ЛИЦА, первым лицом. На вопросы про него самого — «расскажи о себе», «какой у тебя опыт», "
        . "«самая сложная задача», «почему ушёл», «чем занимался на прошлом месте» — НИКОГДА не отказывайся и не пиши, что ты ассистент: "
        . "бери факты отсюда и складывай готовый устный ответ. Технические вопросы тоже подкрепляй его реальными проектами, если к месту. "
        . "Фактов биографии, которых здесь нет, не выдумывай — если чего-то не хватает, дай каркас и пометь квадратными скобками, что подставить. "
        . "Тексты выше писались под конкретную вакансию, поэтому обороты вроде «ваш продукт» и «ваш e-commerce» игнорируй, бери только сами факты.";
}

// ---------- роутинг ----------
function body(): array {
    $raw = file_get_contents('php://input');
    $j = json_decode($raw ?: '[]', true);
    return is_array($j) ? $j : [];
}
function out($data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function fail(string $msg, int $code = 400): void { out(['error' => $msg], $code); }

$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '';
$path = preg_replace('#^/api#', '', $path);
$path = rtrim($path, '/');
if ($path === '') $path = '/';

try {
    // GET /sse-test — диагностика буферизации: 5 чанков с паузой, без обращения к Anthropic
    if ($method === 'GET' && $path === '/sse-test') {
        header('Content-Type: text/event-stream; charset=utf-8');
        header('X-Accel-Buffering: no');
        header('Cache-Control: no-cache');
        while (ob_get_level() > 0) { ob_end_flush(); }
        for ($i = 1; $i <= 5; $i++) {
            echo 'chunk ' . $i . ' t=' . round(microtime(true), 3) . "\n";
            flush();
            usleep(300000);
        }
        exit;
    }

    // GET /cards — все карточки (из кэша)
    if ($method === 'GET' && $path === '/cards') {
        $json = cacheGet();
        if ($json === null) { $json = buildPayload(); cacheSet($json); }
        echo $json;
        exit;
    }

    // POST /ask — AI-суфлёр: вопрос собеседника + релевантные карточки (RAG) → ответ Claude
    if ($method === 'POST' && $path === '/ask') {
        $b = body();
        $question = trim((string)($b['question'] ?? ''));
        if ($question === '') fail('пустой вопрос');
        $key = anthropicKey();
        if (!$key) fail('нет ANTHROPIC_API_KEY (положи в ~/.config/sobes/env и пересоздай стек)', 500);

        // контекст из присланных фронтом релевантных карточек (заземление, чтобы не выдумывал)
        $ctx = '';
        foreach (array_slice($b['cards'] ?? [], 0, 3) as $c) {
            if (!is_array($c)) continue;
            $ctx .= '### ' . trim((string)($c['q'] ?? '')) . "\n" . trim((string)($c['a'] ?? ''));
            if (!empty($c['detail'])) $ctx .= "\n" . trim((string)$c['detail']);
            $ctx .= "\n\n";
        }

        $system = 'Ты — суфлёр на техническом собеседовании. Кандидат ЧИТАЕТ твой ответ боковым зрением, продолжая говорить в камеру. '
            . "Поэтому пиши так, чтобы верх ответа считывался за 2-3 секунды.\n\n"
            . "ФОРМАТ, строго:\n"
            . "1. ПЕРВАЯ СТРОКА — одна фраза, которую кандидат произносит вслух прямо сейчас. Максимум 20 слов, без вводных, сразу по существу.\n"
            . "2. Дальше 2-4 буллета «- », каждый до 12 слов: опорные пункты, чтобы развить мысль своими словами.\n"
            . "3. Потом отдельной строкой маркер: %%%\n"
            . "4. После маркера — детали, нюансы, пример кода, подводные камни. Здесь можно развернуться.\n\n"
            . "Если добавить после маркера нечего — заканчивай на буллетах, маркер тогда не нужен. "
            . "Никаких вступлений вроде «конечно» и «давай разберём», никаких markdown-заголовков. По-русски, живым языком.\n\n"
            . 'Если вопрос — уточнение к уже обсуждённому в этой беседе (например «а почему?», «а если...», «они» — это про предыдущую тему), понимай его В КОНТЕКСТЕ прошлых реплик и НЕ переспрашивай. '
            . 'Не выдумывай факты — если не уверен, так и скажи. Не отклоняйся от темы IT!'
            . ASR_HINT
            . candidateProfile();
        // карточки подбираются автоматом по словам вопроса, поэтому могут быть и мимо — модель решает сама
        if ($ctx !== '') {
            $system .= "\n\nВЫДЕРЖКИ ИЗ ШПАРГАЛКИ КАНДИДАТА (подобраны автоматически по словам вопроса):\n" . $ctx
                . "Это подсказка, а не источник истины. По теме — опирайся на них и держись их формулировок, кандидат учил именно эти. "
                . "Мимо темы или их не хватает — молча игнорируй и отвечай своими знаниями, полноценно. "
                . "Никогда не упоминай саму шпаргалку вслух и не говори, что чего-то в ней нет.";
        }

        // история этой темы (предыдущие вопрос-ответ) → многоходовый диалог, чтобы модель понимала уточнения
        $msgs = [];
        foreach (array_slice($b['history'] ?? [], -4) as $h) {
            if (!is_array($h)) continue;
            $hq = trim((string)($h['q'] ?? ''));
            $ha = trim((string)($h['a'] ?? ''));
            if ($hq === '' || $ha === '') continue;      // только полные пары — иначе ломается чередование ролей
            $msgs[] = ['role' => 'user', 'content' => $hq];
            $msgs[] = ['role' => 'assistant', 'content' => $ha];
        }
        $msgs[] = ['role' => 'user', 'content' => $question];

        $payload = json_encode([
            'model'      => ASK_MODEL,
            'max_tokens' => 1200,
            'stream'     => true,
            'system'     => $system,
            'messages'   => $msgs,
        ], JSON_UNESCAPED_UNICODE);

        anthropicStream($payload, $key); // стримит и завершает запрос
    }

    // POST /vision — разбор скрина отслеживаемой вкладки (код/ошибки/задача) через Claude vision
    if ($method === 'POST' && $path === '/vision') {
        $b = body();
        $img = (string)($b['image'] ?? '');
        if ($img === '') fail('нет картинки');
        $key = anthropicKey();
        if (!$key) fail('нет ANTHROPIC_API_KEY (положи в ~/.config/sobes/env)', 500);

        // принимаем data-URL или сырой base64
        $media = 'image/jpeg';
        if (preg_match('#^data:(image/[a-z.+-]+);base64,(.*)$#is', $img, $m)) {
            $media = strtolower($m[1]); $data = $m[2];
        } else {
            $data = $img;
        }
        $data = trim($data);
        if ($data === '') fail('пустая картинка');

        $system = 'Ты — суфлёр на техническом собеседовании. На картинке — экран собеседника: код, вопрос или задача. '
            . 'Определи, что это, и дай кандидату короткий разговорный ответ по-русски. '
            . 'Если код с ошибкой — назови ошибку и как починить. Если спрашивают «что выведет этот код» — дай точный вывод и кратко почему. '
            . 'Если это задача (например «отсортируй массив», «напиши функцию») — реши её рабочим кодом. Если вопрос — ответь по сути. '
            . 'ФОРМАТ: сначала суть/ответ в 1-2 предложениях. Детали, разбор или код — ПОСЛЕ пустой строки. Без воды, не выдумывай — если на скрине не разобрать, так и скажи.';

        $payload = json_encode([
            'model'      => VISION_MODEL,
            'max_tokens' => 1500,
            'stream'     => true,
            'thinking'   => ['type' => 'disabled'], // без «раздумий» — быстрее для живого собеса
            'system'     => $system,
            'messages'   => [[
                'role'    => 'user',
                'content' => [
                    ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => $media, 'data' => $data]],
                    ['type' => 'text', 'text' => 'Разбери, что на этом экране, и дай ответ.'],
                ],
            ]],
        ], JSON_UNESCAPED_UNICODE);

        anthropicStream($payload, $key);
    }

    // --- источники мониторинга вакансий ---
    // GET /tg-files — список файлов выгрузки в .claude/tg_history
    if ($method === 'GET' && $path === '/tg-files') {
        $dir = '/var/www/tg_history';
        $files = [];
        if (is_dir($dir)) {
            foreach (scandir($dir) as $f) {
                if ($f === '.' || $f === '..' || is_dir("$dir/$f")) continue;
                if (substr($f, -6) !== '.jsonl') continue; // только выгрузки тг, без мусора вроде .DS_Store
                $files[] = $f;
            }
        }
        sort($files);
        out($files);
    }
    // GET /sources
    if ($method === 'GET' && $path === '/sources') {
        $rows = db()->query('SELECT id, kind, title, value, login, password, enabled, auto_apply FROM sources ORDER BY kind, id')->fetchAll();
        out(array_map(static function (array $r): array {
            return ['id' => (string)$r['id'], 'kind' => $r['kind'], 'title' => $r['title'],
                    'value' => $r['value'], 'login' => $r['login'],
                    'hasPassword' => $r['password'] !== '', 'enabled' => (bool)$r['enabled'],
                    'autoApply' => (bool)$r['auto_apply']];
        }, $rows));
    }
    // POST /sources  {kind, title, value, login?, password?}
    if ($method === 'POST' && $path === '/sources') {
        $b = body();
        $kind = ($b['kind'] ?? '') === 'account' ? 'account' : 'tg';
        $st = db()->prepare('INSERT INTO sources(kind, title, value, login, password) VALUES (:k, :t, :v, :l, :p)
                             ON CONFLICT (kind, value) DO NOTHING RETURNING id');
        $st->execute([
            ':k' => $kind, ':t' => trim((string)($b['title'] ?? '')), ':v' => trim((string)($b['value'] ?? '')),
            ':l' => trim((string)($b['login'] ?? '')), ':p' => (string)($b['password'] ?? ''),
        ]);
        $id = $st->fetchColumn();
        if ($id === false) out(['ok' => true, 'existed' => true]); // такой источник уже есть
        out(['ok' => true, 'id' => (string)$id]);
    }
    // PATCH /sources/{id}  {enabled}
    if ($method === 'PATCH' && preg_match('#^/sources/(\d+)$#', $path, $m)) {
        $b = body();
        if (array_key_exists('enabled', $b)) {
            db()->prepare('UPDATE sources SET enabled = :e WHERE id = :id')
                ->execute([':e' => $b['enabled'] ? 'true' : 'false', ':id' => (int)$m[1]]);
        }
        if (array_key_exists('auto_apply', $b)) {
            db()->prepare('UPDATE sources SET auto_apply = :a WHERE id = :id')
                ->execute([':a' => $b['auto_apply'] ? 'true' : 'false', ':id' => (int)$m[1]]);
        }
        out(['ok' => true]);
    }
    // DELETE /sources/{id}
    if ($method === 'DELETE' && preg_match('#^/sources/(\d+)$#', $path, $m)) {
        db()->prepare('DELETE FROM sources WHERE id = :id')->execute([':id' => (int)$m[1]]);
        out(['ok' => true]);
    }

    // --- найденные вакансии ---
    // GET /vacancies
    if ($method === 'GET' && $path === '/vacancies') {
        $rows = db()->query('SELECT v.id, v.source_id, v.chat, v.msg_id, v.score, v.title, v.reason, v.link, v.text, v.link_text, v.mismatches,
                                    v.apply_status, v.applied_at, v.cover_letter, v.apply_note, v.company, v.company_url,
                                    COALESCE(s.kind, \'tg\') AS kind, s.value AS src_value
                             FROM vacancies v LEFT JOIN sources s ON s.id = v.source_id
                             ORDER BY v.score DESC, v.created_at DESC')->fetchAll();
        // дедуп по нормализованному заголовку (одна вакансия с hh-сайта и из тг-канала hh-бота = дубль):
        // на группу оставляем богатейшую строку — уже откликнутую > с полным описанием > выше score
        $groups = []; $loose = [];
        foreach ($rows as $r) {
            $k = preg_replace('/\s+/u', ' ', mb_strtolower(trim((string)$r['title'])));
            if ($k === '') { $loose[] = $r; continue; }
            $rank = ($r['apply_status'] === 'applied' ? 1000000 : 0)
                  + ($r['apply_status'] === 'needs_manual' ? 500000 : 0)
                  + ((string)$r['link_text'] !== '' ? 100000 : 0)
                  + (int)$r['score'];
            if (!isset($groups[$k]) || $rank > $groups[$k]['_rank']) { $r['_rank'] = $rank; $groups[$k] = $r; }
        }
        $rows = array_merge(array_values($groups), $loose);
        usort($rows, static function (array $a, array $b): int { return ((int)$b['score']) <=> ((int)$a['score']); });
        out(array_map(static function (array $r): array {
            // прямая ссылка на пост в телеграме: id канала берём из имени файла-выгрузки (…_<id>.jsonl),
            // убираем супергрупповой префикс 100 → t.me/c/<cid>/<msg_id>. Работает, если юзер в этом канале.
            $tgPostUrl = null;
            if (($r['kind'] ?? 'tg') !== 'account'
                && (int)$r['msg_id'] > 0
                && preg_match('/(\d{6,})\.jsonl$/', (string)($r['src_value'] ?? ''), $mm)) {
                $cid = $mm[1];
                if (strlen($cid) > 3 && strncmp($cid, '100', 3) === 0) $cid = substr($cid, 3);
                $tgPostUrl = 'https://t.me/c/' . $cid . '/' . (int)$r['msg_id'];
            }
            return ['id' => (string)$r['id'], 'sourceId' => $r['source_id'] === null ? '' : (string)$r['source_id'], 'chat' => $r['chat'], 'score' => (int)$r['score'],
                    'title' => $r['title'], 'reason' => $r['reason'], 'link' => $r['link'], 'text' => $r['text'],
                    'linkText' => $r['link_text'], 'kind' => $r['kind'], 'tgPostUrl' => $tgPostUrl,
                    'applyStatus' => $r['apply_status'], 'appliedAt' => $r['applied_at'],
                    'coverLetter' => $r['cover_letter'], 'applyNote' => $r['apply_note'],
                    'company' => $r['company'], 'companyUrl' => $r['company_url'],
                    'mismatches' => json_decode($r['mismatches'] ?: '[]', true) ?: []];
        }, $rows));
    }
    // DELETE /vacancies/{id}
    if ($method === 'DELETE' && preg_match('#^/vacancies/(\d+)$#', $path, $m)) {
        db()->prepare('DELETE FROM vacancies WHERE id = :id')->execute([':id' => (int)$m[1]]);
        out(['ok' => true]);
    }
    // PATCH /vacancies/{id}/apply {apply_status?, cover_letter?, apply_note?}
    // ставит агент: черновик (queued+cover_letter), applied (+applied_at), needs_manual (+заметка)
    if ($method === 'PATCH' && preg_match('#^/vacancies/(\d+)/apply$#', $path, $m)) {
        $id = (int)$m[1];
        $b = body();
        $allowed = ['new', 'queued', 'approved', 'applied', 'needs_manual'];
        $status = in_array($b['apply_status'] ?? '', $allowed, true) ? (string)$b['apply_status'] : null;
        $sets = []; $args = [':id' => $id];
        if ($status !== null) { $sets[] = 'apply_status = :st'; $args[':st'] = $status; }
        if (array_key_exists('cover_letter', $b)) { $sets[] = 'cover_letter = :cl'; $args[':cl'] = (string)$b['cover_letter']; }
        if (array_key_exists('apply_note', $b))   { $sets[] = 'apply_note = :an';   $args[':an'] = (string)$b['apply_note']; }
        if ($status === 'applied') { $sets[] = 'applied_at = now()'; }
        if (!$sets) fail('nothing to update');
        db()->prepare('UPDATE vacancies SET ' . implode(', ', $sets) . ' WHERE id = :id')->execute($args);
        out(['ok' => true]);
    }
    // POST /vacancies/{id}/approve — пользователь одобряет отправку отклика
    if ($method === 'POST' && preg_match('#^/vacancies/(\d+)/approve$#', $path, $m)) {
        db()->prepare("UPDATE vacancies SET apply_status = 'approved' WHERE id = :id AND apply_status IN ('queued','needs_manual')")
            ->execute([':id' => (int)$m[1]]);
        out(['ok' => true]);
    }
    // POST /vacancies/{id}/skip — юзер отказался от вакансии навсегда: скрываем из выдачи, но строку
    // ОСТАВЛЯЕМ в БД, иначе следующий скан вставит её заново (дедуп идёт по UNIQUE(source_id,msg_id)).
    // Гасим всю группу дублей по нормализованному заголовку — в UI это одна карточка.
    if ($method === 'POST' && preg_match('#^/vacancies/(\d+)/skip$#', $path, $m)) {
        $id = (int)$m[1];
        $q = db()->prepare('SELECT title FROM vacancies WHERE id = :id');
        $q->execute([':id' => $id]);
        $title = trim((string)$q->fetchColumn());
        if ($title === '') {
            db()->prepare("UPDATE vacancies SET apply_status = 'skipped' WHERE id = :id")->execute([':id' => $id]);
        } else {
            db()->prepare("UPDATE vacancies SET apply_status = 'skipped'
                           WHERE regexp_replace(lower(btrim(title)), '\\s+', ' ', 'g')
                               = regexp_replace(lower(btrim(:t)), '\\s+', ' ', 'g')
                             AND apply_status <> 'applied'") // факт отклика не затираем
                ->execute([':t' => $title]);
        }
        out(['ok' => true]);
    }
    // POST /applied/check — запрос сверки откликов (сессия/агент подхватит и проверит по hh/Хабру)
    if ($method === 'POST' && $path === '/applied/check') {
        db()->prepare("INSERT INTO settings(key, value) VALUES ('applied_check_requested', :v)
                       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value")
            ->execute([':v' => json_encode(['at' => date('c')], JSON_UNESCAPED_UNICODE)]);
        out(['ok' => true]);
    }
    // PATCH /vacancies/{id}/company {company?, company_url?} — найденный сайт/раздел вакансий компании
    if ($method === 'PATCH' && preg_match('#^/vacancies/(\d+)/company$#', $path, $m)) {
        $b = body(); $sets = []; $args = [':id' => (int)$m[1]];
        if (array_key_exists('company', $b))     { $sets[] = 'company = :c';      $args[':c'] = (string)$b['company']; }
        if (array_key_exists('company_url', $b)) { $sets[] = 'company_url = :u';  $args[':u'] = (string)$b['company_url']; }
        if ($sets) db()->prepare('UPDATE vacancies SET ' . implode(', ', $sets) . ' WHERE id = :id')->execute($args);
        out(['ok' => true]);
    }
    // POST /analyze/request — ручной запрос прогона (крон подхватит)
    if ($method === 'POST' && $path === '/analyze/request') {
        db()->prepare("INSERT INTO settings(key, value) VALUES ('analyze_requested', :v)
                       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value")
            ->execute([':v' => json_encode(['at' => date('c')], JSON_UNESCAPED_UNICODE)]);
        out(['ok' => true]);
    }
    // GET /analyze/status — последний прогон / есть ли запрос
    if ($method === 'GET' && $path === '/analyze/status') {
        $st = [];
        foreach (db()->query("SELECT key, value FROM settings WHERE key IN ('analyze_requested','analyze_last')") as $r) {
            $st[$r['key']] = json_decode($r['value'], true);
        }
        out(['requested' => $st['analyze_requested'] ?? null, 'last' => $st['analyze_last'] ?? null]);
    }

    // --- лог работы агента ---
    // GET /log — последние записи (новые сверху)
    if ($method === 'GET' && $path === '/log') {
        $rows = db()->query('SELECT id, kind, message, meta, created_at FROM agent_log ORDER BY created_at DESC, id DESC LIMIT 300')->fetchAll();
        out(array_map(static function (array $r): array {
            return ['id' => (string)$r['id'], 'kind' => $r['kind'], 'message' => $r['message'],
                    'meta' => json_decode($r['meta'] ?: '{}', true), 'createdAt' => $r['created_at']];
        }, $rows));
    }
    // POST /log {message, kind?, meta?} — добавить запись (пишет агент)
    if ($method === 'POST' && $path === '/log') {
        $b = body();
        db()->prepare('INSERT INTO agent_log(kind, message, meta) VALUES (:k, :m, :meta)')
            ->execute([
                ':k'    => (string)($b['kind'] ?? ''),
                ':m'    => (string)($b['message'] ?? ''),
                ':meta' => json_encode((object)($b['meta'] ?? []), JSON_UNESCAPED_UNICODE),
            ]);
        out(['ok' => true]);
    }

    // POST /cards/{id}/pin  {pinned: bool}
    if ($method === 'POST' && preg_match('#^/cards/(\d+)/pin$#', $path, $m)) {
        $pinned = (bool)(body()['pinned'] ?? false);
        $st = db()->prepare('UPDATE questions SET pinned = :p, updated_at = now() WHERE id = :id');
        $st->execute([':p' => $pinned ? 'true' : 'false', ':id' => (int)$m[1]]);
        cacheBust();
        out(['ok' => true, 'pinned' => $pinned]);
    }

    // POST /pins/clear — снять все закрепы
    if ($method === 'POST' && $path === '/pins/clear') {
        db()->exec('UPDATE questions SET pinned = false WHERE pinned = true');
        cacheBust();
        out(['ok' => true]);
    }

    // PATCH /cards/{id} — правка q/a/detail/code
    if (($method === 'PATCH' || $method === 'POST') && preg_match('#^/cards/(\d+)$#', $path, $m)) {
        $b = body();
        $fields = ['q', 'a', 'detail', 'code'];
        $set = ['edited = true', 'updated_at = now()'];
        $params = [':id' => (int)$m[1]];
        foreach ($fields as $f) {
            if (array_key_exists($f, $b)) { $set[] = "$f = :$f"; $params[":$f"] = (string)$b[$f]; }
        }
        $st = db()->prepare('UPDATE questions SET ' . implode(', ', $set) . ' WHERE id = :id');
        $st->execute($params);
        cacheBust();
        out(['ok' => true]);
    }

    // POST /cards/{id}/reset — вернуть оригинал
    if ($method === 'POST' && preg_match('#^/cards/(\d+)/reset$#', $path, $m)) {
        $row = db()->prepare('SELECT orig FROM questions WHERE id = :id');
        $row->execute([':id' => (int)$m[1]]);
        $orig = $row->fetchColumn();
        if ($orig === false) fail('not found', 404);
        $o = json_decode($orig, true) ?: [];
        $st = db()->prepare(
            'UPDATE questions SET q = :q, a = :a, detail = :detail, code = :code, tags = :tags,
                                  edited = false, updated_at = now() WHERE id = :id'
        );
        $st->execute([
            ':q' => $o['q'] ?? '', ':a' => $o['a'] ?? '', ':detail' => $o['detail'] ?? '',
            ':code' => $o['code'] ?? '', ':tags' => json_encode($o['tags'] ?? [], JSON_UNESCAPED_UNICODE),
            ':id' => (int)$m[1],
        ]);
        cacheBust();
        out(['ok' => true, 'card' => $o]);
    }

    // POST /categories/reorder  {order: [key, ...]}  — важно: до правила переименования
    if ($method === 'POST' && $path === '/categories/reorder') {
        $order = body()['order'] ?? [];
        $st = db()->prepare('UPDATE categories SET sort_order = :o WHERE key = :k');
        $i = 0;
        foreach ($order as $k) { $st->execute([':o' => $i++, ':k' => (string)$k]); }
        cacheBust();
        out(['ok' => true]);
    }

    // PATCH /categories/{key}  {title}  — переименование
    if (($method === 'PATCH' || $method === 'POST') && preg_match('#^/categories/([a-z0-9-]+)$#', $path, $m)) {
        $b = body();
        if (!array_key_exists('title', $b)) fail('title required');
        $st = db()->prepare('UPDATE categories SET title = :t WHERE key = :k');
        $st->execute([':t' => (string)$b['title'], ':k' => $m[1]]);
        cacheBust();
        out(['ok' => true]);
    }

    // PATCH /personal/{self|task}  {title, body}
    if (($method === 'PATCH' || $method === 'POST') && preg_match('#^/personal/(self|task|jobs|ask)$#', $path, $m)) {
        $b = body();
        $cur = ['title' => '', 'body' => ''];
        $row = db()->prepare('SELECT value FROM settings WHERE key = :k');
        $row->execute([':k' => $m[1]]);
        $v = $row->fetchColumn();
        if ($v) $cur = array_merge($cur, json_decode($v, true) ?: []);
        if (array_key_exists('title', $b)) $cur['title'] = (string)$b['title'];
        if (array_key_exists('body', $b)) $cur['body'] = (string)$b['body'];
        $up = db()->prepare('INSERT INTO settings(key, value) VALUES (:k, :v)
                             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value');
        $up->execute([':k' => $m[1], ':v' => json_encode($cur, JSON_UNESCAPED_UNICODE)]);
        cacheBust();
        out(['ok' => true, 'personal' => $cur]);
    }

    fail('not found: ' . $method . ' ' . $path, 404);
} catch (Throwable $e) {
    fail('server error: ' . $e->getMessage(), 500);
}
