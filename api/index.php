<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

const CACHE_KEY = 'sobes:cards';
// нижняя планка соответствия резюме: ниже неё вакансию в работу не берём — ни отклика, ни поиска контактов
const SCORE_MIN = 70;
// Запросы к Anthropic идут через локальный nginx (docker/site.conf, порт 8081): он держит keepalive-пул,
// поэтому TCP+TLS (350-450мс) не платятся на каждом вопросе. Прокси лёг — код сам уходит на прямой адрес.
const ANTHROPIC_URL = 'http://sobes-web:8081/anthropic/v1/messages';
const ANTHROPIC_URL_DIRECT = 'https://api.anthropic.com/v1/messages';
// перегрузка/лимит Anthropic ДО первого байта — короткий backoff и повтор (мс). Держит воркер, поэтому коротко.
const RETRY_BACKOFF = [400, 1200];
// сентинел управляющего канала: строки «\x1e<op><payload>\n» в теле стрима. \x1e (RS) в тексте модели не встречается,
// поэтому клиент (api.js) отличает их от ответа. op: 'e'=ошибка (json {kind,message}), 'k'=keepalive (глотается).
const CTL = "\x1e";
// модель AI-суфлёра. Быстрая/дешёвая — haiku (для живого суфлёра). Умнее/медленнее: claude-sonnet-5, claude-opus-4-8.
const ASK_MODEL = 'claude-haiku-4-5';
// модель разбора скрина (vision): sonnet-5 — сильна по коду; можно claude-opus-4-8 для сложных задач.
const VISION_MODEL = 'claude-sonnet-5';
// куда пишутся файлы записей встреч (том ./recordings; nginx отдаёт эту же папку как /rec/)
const REC_DIR = '/var/www/recordings';

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

// Высокоточная карта поломок ASR для КЛИЕНТСКОЙ постобработки (правит сырой финал ПЕРЕД маршрутизацией темы и RAG —
// иначе «кофта» не находит карточки Kafka). Только различимые, однозначные поломки; короткие/двусмысленные («оп»→ООП)
// сюда НЕ кладём — их модель чинит с контекстом через ASR_HINT, а тупая клиентская замена дала бы ложные срабатывания.
// Ключи — в нижнем регистре. Отдаётся фронту роутом /asr-terms.
const ASR_FIXES = [
    'ларавель жопа' => 'Laravel jobs', 'ларавель жоба' => 'Laravel jobs', 'ларавель джобс' => 'Laravel jobs',
    'кофта' => 'Kafka', 'губер нет тест' => 'Kubernetes', 'кубер нетис' => 'Kubernetes',
    'постгрес' => 'PostgreSQL', 'майскл' => 'MySQL', 'раббит' => 'RabbitMQ', 'редис' => 'Redis',
    'элоквент' => 'Eloquent', 'композер' => 'Composer', 'клоужер' => 'closure', 'мидлвар' => 'middleware',
    'опкеш' => 'OPcache', 'опкэш' => 'OPcache', 'дедлок' => 'deadlock', 'аутбокс' => 'outbox',
    'хендлер' => 'handler', 'неймспейс' => 'namespace', 'оауф' => 'OAuth', 'воркер' => 'worker',
    'ретрай' => 'retry', 'джоба' => 'job', 'жоба' => 'job', 'асид' => 'ACID', 'джойн' => 'join',
    'докер' => 'Docker', 'эластик' => 'Elasticsearch', 'протобаф' => 'protobuf', 'вебхук' => 'webhook',
    // поймано на прогоне whisper: он ломает термины иначе, чем браузер, но так же однозначно
    'промэтис' => 'Prometheus', 'прометис' => 'Prometheus', 'бэков' => 'backoff', 'бэкоф' => 'backoff',
    'ретрис' => 'retry', 'ратрис' => 'retry', 'дедлока' => 'deadlock', 'кубернетис' => 'Kubernetes',
    'декр' => 'Docker', 'decker' => 'Docker', 'кьюборниц' => 'Kubernetes', 'кьюбарниц' => 'Kubernetes',
    'q-bornitz' => 'Kubernetes', 'депло' => 'деплой', 'deplay' => 'деплой',
];

// Словарь стека ИЗ СВОЕЙ БД: латиница из карточек с частотой ≥3 — реальные термины, которые встречаются в вопросах.
// Кэшируется в Redis (бьётся вместе с sobes:cards в cacheBust). Используется фронтом как справка канонических написаний.
const ASR_TERMS_KEY = 'sobes:asr-terms';
function asrTermsVocab(): array {
    $r = redis();
    if ($r) { try { $c = $r->get(ASR_TERMS_KEY); if ($c !== false && $c !== null) { $d = json_decode($c, true); if (is_array($d)) return $d; } } catch (Throwable $e) {} }
    try { $pdo = db(); } catch (Throwable $e) { return []; }
    // из ПРОЗЫ (q/a/detail/tags), НЕ из code — там имена переменных/SQL, а не термины стека
    $rows = $pdo->query("SELECT q || ' ' || a || ' ' || detail || ' ' || tags::text AS t FROM questions")->fetchAll(PDO::FETCH_COLUMN);
    static $stop = ['the'=>1,'and'=>1,'for'=>1,'you'=>1,'with'=>1,'that'=>1,'this'=>1,'from'=>1,'not'=>1,'are'=>1,'was'=>1,'will'=>1,'can'=>1,'has'=>1,'have'=>1,'but'=>1,'all'=>1,'out'=>1,'one'=>1,'two'=>1,'use'=>1,'new'=>1,'per'=>1,'via'=>1,'get'=>1,'set'=>1,'now'=>1,'end'=>1,'key'=>1,'val'=>1,'foo'=>1,'bar'=>1,'baz'=>1];
    $freq = []; $case = [];
    foreach ($rows as $t) {
        // токен: буква + буквы/цифры, допускаем один дефис/плюс/решётку (B-tree, N+1, C#); точку НЕ берём — там code-мусор (u.name)
        if (!preg_match_all('/[A-Za-z][A-Za-z0-9]*(?:[+#-][A-Za-z0-9]+)?/', (string)$t, $m)) continue;
        foreach ($m[0] as $tok) {
            $low = strtolower($tok);
            $letters = preg_replace('/[^a-z]/', '', $low);
            if (strlen($low) < 3 || strlen($letters) < 2 || isset($stop[$low])) continue;   // мусор/короткие/стоп
            $freq[$low] = ($freq[$low] ?? 0) + 1;
            $case[$low][$tok] = ($case[$low][$tok] ?? 0) + 1;   // копим варианты написания, канон = самый частый
        }
    }
    $terms = [];
    foreach ($freq as $low => $n) {
        if ($n < 3) continue;
        arsort($case[$low]);
        $terms[] = array_key_first($case[$low]);
    }
    sort($terms, SORT_NATURAL | SORT_FLAG_CASE);
    if ($r) { try { $r->set(ASR_TERMS_KEY, json_encode($terms, JSON_UNESCAPED_UNICODE)); } catch (Throwable $e) {} }
    return $terms;
}

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
    try { $r = redis(); if ($r) $r->del(CACHE_KEY, ASR_TERMS_KEY); } catch (Throwable $e) {}  // словарь стека тоже пересобрать
}

// Секрет по имени: из env-переменной контейнера или из примонтированного секрет-файла (вне репозитория)
function secretVar(string $name): ?string {
    $k = getenv($name);
    if ($k) return trim($k);
    $f = '/var/www/secret.env';
    $found = null;
    if (is_file($f)) {
        foreach (file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            if (preg_match('/^\s*' . $name . '\s*=\s*(.+)$/', $line, $m)) {
                $found = trim($m[1], " \t\"'"); // последняя строка выигрывает (свежедописанное значение)
            }
        }
    }
    return $found;
}
function anthropicKey(): ?string { return secretVar('ANTHROPIC_API_KEY'); }
// Мост подписки (scripts/bridge.py, launchd com.sobes.bridge): есть SOBES_LLM_URL в секретах —
// стрим идёт через него на OAuth-токене подписки, а «ключом» служит BRIDGE_SECRET
// (мост слушает 0.0.0.0, т.к. docker до 127.0.0.1 мака не достаёт, и без секрета отдаёт 401).
function bridgeUrl(): ?string { return secretVar('SOBES_LLM_URL'); }
function llmKey(): ?string { return bridgeUrl() ? secretVar('BRIDGE_SECRET') : anthropicKey(); }

// стримит ответ Anthropic по SSE прямо в тело HTTP-ответа (text/event-stream — не буферизуется nginx). Завершает запрос.
// Ошибки НЕ подмешиваются в текст ответа, а уходят управляющей строкой «\x1e e{json}» — клиент показывает их отдельно
// и рисует кнопку повтора, а не выдаёт за ответ модели. Keepalive «\x1e k» держит FPM в курсе обрыва клиента.
function anthropicStream(string $payload, string $key): void {
    header('Content-Type: text/event-stream; charset=utf-8');
    header('X-Accel-Buffering: no');
    header('Cache-Control: no-cache');
    while (ob_get_level() > 0) { ob_end_flush(); }

    $emitError = function (string $kind, string $message) {
        echo CTL . 'e' . json_encode(['kind' => $kind, 'message' => $message], JSON_UNESCAPED_UNICODE) . "\n";
        flush();
    };

    $buf = '';
    $sent = false;                       // ушёл ли клиенту хоть кусок ТЕКСТА — после этого ни ретрай, ни фолбэк нельзя
    $streamErr = null;                   // ошибка из SSE-события (напр. overloaded_error) — эхо в текст не идёт
    $lastWrite = microtime(true);        // когда последний раз что-то писали клиенту (для keepalive)
    $write = function ($c, $data) use (&$buf, &$sent, &$streamErr, &$lastWrite) {
        $buf .= $data;
        while (($nl = strpos($buf, "\n")) !== false) {
            $line = trim(substr($buf, 0, $nl));
            $buf = substr($buf, $nl + 1);
            if ($line === '' || strncmp($line, 'data:', 5) !== 0) continue;
            $ev = json_decode(trim(substr($line, 5)), true);
            if (!is_array($ev)) continue;
            $t = $ev['type'] ?? '';
            if ($t === 'content_block_delta' && ($ev['delta']['type'] ?? '') === 'text_delta') {
                echo str_replace(CTL, '', $ev['delta']['text']);   // сентинел вырезаем из текста модели — контракт железный, а не «предполагаем»
                $sent = true; $lastWrite = microtime(true); flush();
            } elseif ($t === 'error') {
                $streamErr = ['type' => (string)($ev['error']['type'] ?? ''), 'message' => (string)($ev['error']['message'] ?? '?')];
            }
        }
        return strlen($data);
    };
    // прогресс-колбэк libcurl зовётся ~раз в секунду ДАЖЕ когда Anthropic молчит. Пишем keepalive и проверяем обрыв:
    // PHP замечает уход клиента только при попытке вывода, поэтому без этого воркер висел бы до CURLOPT_TIMEOUT (90с).
    $progress = function ($ch, $dltot, $dlnow, $ultot, $ulnow) use (&$lastWrite) {
        if (connection_aborted()) return 1;
        if (microtime(true) - $lastWrite > 0.8) {          // молчим уже почти секунду — пингуем, чтобы уловить обрыв
            echo CTL . "k\n"; flush();
            $lastWrite = microtime(true);
            if (connection_aborted()) return 1;            // клиент ушёл → рвём curl → освобождаем воркер
        }
        return 0;
    };
    $run = function (string $url) use ($payload, &$key, $write, $progress, &$buf) {
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
            CURLOPT_NOPROGRESS => false,
            CURLOPT_PROGRESSFUNCTION => $progress,
        ]);
        curl_exec($ch);
        $r = [(int)curl_getinfo($ch, CURLINFO_HTTP_CODE), curl_error($ch), curl_errno($ch)];
        curl_close($ch);
        return $r;
    };

    $url = bridgeUrl() ?: ANTHROPIC_URL;
    $triedDirect = false;
    $attempt = 0;
    $code = 0; $curlErr = ''; $errno = 0;
    while (true) {
        $streamErr = null;
        [$code, $curlErr, $errno] = $run($url);
        if ($sent) break;                                  // текст уже пошёл — падать на фолбэк/ретрай поздно

        // прокси/мост лёг → один раз уходим напрямую (мимо моста — только если есть настоящий API-ключ)
        $connFail = in_array($errno, [CURLE_COULDNT_CONNECT, CURLE_COULDNT_RESOLVE_HOST, CURLE_GOT_NOTHING, CURLE_RECV_ERROR, CURLE_SEND_ERROR], true);
        if (!$triedDirect && ($connFail || $code === 502 || $code === 504) && (!bridgeUrl() || anthropicKey())) {
            error_log('sobes: ' . (bridgeUrl() ? 'мост подписки' : 'keepalive-прокси') . ' недоступен (errno=' . $errno . ', code=' . $code . '), иду напрямую');
            if (bridgeUrl()) $key = anthropicKey();
            $url = ANTHROPIC_URL_DIRECT; $triedDirect = true;
            continue;
        }
        // перегрузка/лимит Anthropic до первого байта → короткий backoff и повтор
        $retryable = $code === 429 || $code === 529 || ($streamErr && $streamErr['type'] === 'overloaded_error');
        if ($retryable && $attempt < count(RETRY_BACKOFF)) {
            usleep(RETRY_BACKOFF[$attempt] * 1000);
            $attempt++;
            continue;
        }
        break;
    }

    if ($code >= 400) {                                    // ошибка ДО стрима (401/429/529/…): тело — JSON в $buf
        $e = json_decode($buf, true);
        $msg = $e['error']['message'] ?? ($streamErr['message'] ?? ($curlErr ?: 'неизвестная ошибка'));
        $emitError('api', 'Anthropic: ' . $msg . ' (' . $code . ')');
    } elseif ($streamErr) {                                // SSE-ошибка (в т.ч. после части текста)
        $emitError('api', 'Anthropic: ' . $streamErr['message']);
    } elseif ($curlErr !== '') {
        $emitError('network', $curlErr);
    } elseif (!$sent) {                                    // ни текста, ни ошибки — пустой ответ
        $emitError('api', 'пустой ответ от Anthropic');
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

// Одна вакансия лежит в базе несколькими строками (тг-канал hh-бота + сам hh), в UI это одна карточка.
// Группа — совпадающий нормализованный заголовок И не противоречащая компания: пустая с любой стороны
// считается совпадением, потому что company заполнена не у всех строк (иначе связка тг+сайт разваливается
// и на одну вакансию уходит два отклика). Хост ссылки в группу НЕ входит — дубли как раз и приходят
// с разных площадок. Нормализация одна на обе стороны: сначала свернуть пробелы, потом обрезать края.
function vacNorm($s): string { return trim(preg_replace('/\s+/u', ' ', mb_strtolower((string)$s))); }
// то же самое в SQL. btrim ПОСЛЕ свёртки, иначе краевые \n\t не срезаются (btrim без аргумента снимает
// только пробел) и строка перестаёт совпадать сама с собой.
function vacNormSql(string $expr): string { return "btrim(regexp_replace(lower($expr), '\\s+', ' ', 'g'))"; }

/** Вакансия живёт на hh? Смотрим на ссылку, а не на источник: тг-канал hh-бота ведёт туда же. */
function vacOnHh(int $id): bool
{
    $q = db()->prepare('SELECT link FROM vacancies WHERE id = :id');
    $q->execute([':id' => $id]);
    return (bool)preg_match('~(^|[./@])hh\.ru~i', (string)$q->fetchColumn());
}

/** Ставит статус группе дублей вакансии. Уже отправленный отклик и skipped не трогает. */
function setDupeGroup(int $id, string $status, string $note = '', bool $withSelf = false): int
{
    $q = db()->prepare('SELECT title, company FROM vacancies WHERE id = :id');
    $q->execute([':id' => $id]);
    $row = $q->fetch();
    if (!$row) return 0;
    $title = (string)$row['title'];
    $company = (string)$row['company'];
    $args = [':st' => $status, ':note' => $note];
    $sql = "UPDATE vacancies
               SET apply_status = :st,
                   apply_note = concat_ws(' · ', NULLIF(CAST(:note AS text), ''), NULLIF(apply_note, ''))
             WHERE apply_status NOT IN ('applied', 'direct', 'done', 'skipped')";
    if (vacNorm($title) === '') {             // без заголовка группу не собрать — только сама строка
        if (!$withSelf) return 0;
        $sql .= ' AND id = :id'; $args[':id'] = $id;
    } else {
        $sql .= ' AND ' . vacNormSql('title') . ' = ' . vacNormSql(':t');
        $args[':t'] = $title;
        if (vacNorm($company) !== '') {       // работодателя знаем — чужую контору с тем же названием не трогаем
            $sql .= " AND (" . vacNormSql('company') . " = '' OR " . vacNormSql('company') . ' = ' . vacNormSql(':c') . ')';
            $args[':c'] = $company;
        }
        if (!$withSelf) { $sql .= ' AND id <> :id'; $args[':id'] = $id; }
    }
    $st = db()->prepare($sql);
    $st->execute($args);
    return $st->rowCount();
}

/** Строка записи встречи для фронта: файл отдаёт nginx по /rec/, php им не занимается. */
function recRow(array $r): array {
    // время — в ISO: постгресовое «2026-08-03 07:32:14.22+00» браузеры парсят кто во что горазд
    $iso = static function ($v): ?string {
        if (!$v) return null;
        $t = strtotime((string)$v);
        return $t === false ? (string)$v : date('c', $t);
    };
    return [
        'id'         => (string)$r['id'],
        'title'      => $r['title'],
        'url'        => (string)$r['file'] !== '' ? '/rec/' . rawurlencode((string)$r['file']) : '',
        'mime'       => $r['mime'],
        'status'     => $r['status'],
        'size'       => (int)$r['size_bytes'],
        'durationMs' => (int)$r['duration_ms'],
        'transcriptKind' => $r['transcript_kind'] ?? 'live',
        'whisperStatus'  => $r['whisper_status'] ?? '',
        'whisperNote'    => $r['whisper_note'] ?? '',
        'startedAt'  => $iso($r['started_at']),
        'finishedAt' => $iso($r['finished_at']),
    ];
}

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

    // GET /asr-terms — словарь стека из БД + карта поломок ASR для клиентской постобработки речи
    if ($method === 'GET' && $path === '/asr-terms') {
        out(['fixes' => ASR_FIXES, 'terms' => asrTermsVocab()]);
    }

    // POST /ask — AI-суфлёр: вопрос собеседника + релевантные карточки (RAG) → ответ Claude
    if ($method === 'POST' && $path === '/ask') {
        $b = body();
        $question = trim((string)($b['question'] ?? ''));
        if ($question === '') fail('пустой вопрос');
        $key = llmKey();
        if (!$key) fail('нет ни ANTHROPIC_API_KEY, ни моста подписки (SOBES_LLM_URL) — см. ~/.config/sobes/env', 500);

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
        $key = llmKey();
        if (!$key) fail('нет ни ANTHROPIC_API_KEY, ни моста подписки (SOBES_LLM_URL) — см. ~/.config/sobes/env', 500);

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
                                    v.apply_status, v.applied_at, v.cover_letter, v.apply_note, v.company, v.company_url, v.hr_contacts,
                                    COALESCE(s.kind, \'tg\') AS kind, s.value AS src_value
                             FROM vacancies v LEFT JOIN sources s ON s.id = v.source_id
                             ORDER BY v.score DESC, v.created_at DESC')->fetchAll();
        // дедуп по нормализованному заголовку (одна вакансия с hh-сайта и из тг-канала hh-бота = дубль):
        // на группу оставляем богатейшую строку — уже откликнутую > ручной разбор > с полным описанием > выше score.
        // Компания режет группу ТОЛЬКО когда под одним названием реально встретились разные работодатели —
        // тогда «PHP-разработчик» двух контор не склеится в одну карточку. Пока работодатель один или
        // неизвестен, строки клеятся как раньше: у тг-поста компании обычно нет, а у сайтовой строки есть,
        // и строгое сравнение развалило бы связку тг+сайт (две карточки → два отклика на одну вакансию).
        // Хост ссылки в ключ НЕ идёт — дубли как раз и приходят с разных площадок (hh + Хабр + тг).
        $byTitle = []; $loose = [];
        foreach ($rows as $r) {
            $k = vacNorm($r['title']);
            if ($k === '') { $loose[] = $r; continue; }
            $r['_rank'] = ($r['apply_status'] === 'direct' ? 2000000 : 0)  // с прямыми контактами — самая ценная строка группы
                        + ($r['apply_status'] === 'done' ? 1500000 : 0)    // закрытая вакансия перебивает висящий дубль
                        + ($r['apply_status'] === 'applied' ? 1000000 : 0)
                        + ($r['apply_status'] === 'needs_manual' ? 500000 : 0)
                        + ((string)$r['link_text'] !== '' ? 100000 : 0)
                        + (int)$r['score'];
            $byTitle[$k][] = $r;
        }
        $rows = $loose;
        foreach ($byTitle as $grp) {
            $firms = [];
            foreach ($grp as $r) { $c = vacNorm($r['company']); if ($c !== '') $firms[$c] = true; }
            $split = count($firms) > 1;
            $best = [];
            foreach ($grp as $r) {
                $sub = $split ? vacNorm($r['company']) : '';
                if (!isset($best[$sub]) || $r['_rank'] > $best[$sub]['_rank']) $best[$sub] = $r;
            }
            foreach ($best as $r) $rows[] = $r;
        }
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
                    'hrContacts' => json_decode($r['hr_contacts'] ?: '[]', true) ?: [],
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
        $allowed = ['new', 'queued', 'approved', 'applied', 'direct', 'done', 'needs_manual'];
        $status = in_array($b['apply_status'] ?? '', $allowed, true) ? (string)$b['apply_status'] : null;
        $applied = $status === 'applied' || $status === 'done';   // и то и другое = отклик ушёл
        // прямой отклик мимо площадки нужен только на hh: там фильтры гасят отклик, до работодателя
        // он может и не дойти. На остальных площадках письмо доходит — вакансия закрывается сразу.
        if ($status === 'applied' && !vacOnHh($id)) $status = 'done';
        $sets = []; $args = [':id' => $id];
        if ($status !== null) { $sets[] = 'apply_status = :st'; $args[':st'] = $status; }
        if (array_key_exists('cover_letter', $b)) { $sets[] = 'cover_letter = :cl'; $args[':cl'] = (string)$b['cover_letter']; }
        if (array_key_exists('apply_note', $b))   { $sets[] = 'apply_note = :an';   $args[':an'] = (string)$b['apply_note']; }
        if ($applied) { $sets[] = 'applied_at = now()'; }
        if (!$sets) fail('nothing to update');
        // отклик и гашение дублей — одной транзакцией, иначе при падении второго запроса статус уже
        // проставлен, а группа осталась висеть, и вызывающий по 500 не поймёт, что реально произошло
        db()->beginTransaction();
        try {
            db()->prepare('UPDATE vacancies SET ' . implode(', ', $sets) . ' WHERE id = :id')->execute($args);
            // дубли той же вакансии больше не требуют действий. Ставим им skipped, а НЕ applied:
            // сверка откликов на площадке их не найдёт и вернёт в new — и так по кругу.
            $dupes = $applied ? setDupeGroup($id, 'skipped', 'дубль: отклик отправлен по карточке #' . $id) : 0;
            db()->commit();
        } catch (Throwable $e) {
            db()->rollBack();
            throw $e;
        }
        out(['ok' => true, 'dupes' => $dupes]);
    }
    // POST /vacancies/{id}/approve — пользователь одобряет отправку отклика
    if ($method === 'POST' && preg_match('#^/vacancies/(\d+)/approve$#', $path, $m)) {
        db()->prepare("UPDATE vacancies SET apply_status = 'approved' WHERE id = :id AND apply_status IN ('queued','needs_manual')")
            ->execute([':id' => (int)$m[1]]);
        out(['ok' => true]);
    }
    // POST /vacancies/{id}/skip — юзер отказался от вакансии навсегда: скрываем из выдачи, но строку
    // ОСТАВЛЯЕМ в БД, иначе следующий скан вставит её заново (дедуп идёт по UNIQUE(source_id,msg_id)).
    // Гасим всю группу дублей (заголовок + не противоречащая компания: пустая подходит к любой) — в UI это одна карточка.
    if ($method === 'POST' && preg_match('#^/vacancies/(\d+)/skip$#', $path, $m)) {
        setDupeGroup((int)$m[1], 'skipped', '', true); // факт отклика внутри не затирается
        out(['ok' => true]);
    }
    // POST /vacancies/{id}/done — работа по вакансии закончена: контактов не нашлось либо юзер закрыл руками.
    // Гасим и группу дублей, иначе та же вакансия с другой площадки останется висеть в работе.
    if ($method === 'POST' && preg_match('#^/vacancies/(\d+)/done$#', $path, $m)) {
        $id = (int)$m[1];
        $b = body();
        $sets = ["apply_status = 'done'"]; $args = [':id' => $id];
        if (array_key_exists('apply_note', $b)) { $sets[] = 'apply_note = :an'; $args[':an'] = (string)$b['apply_note']; }
        db()->beginTransaction();
        try {
            db()->prepare('UPDATE vacancies SET ' . implode(', ', $sets) . " WHERE id = :id AND apply_status <> 'skipped'")
                ->execute($args);
            $dupes = setDupeGroup($id, 'skipped', 'дубль: закрыта по карточке #' . $id);
            db()->commit();
        } catch (Throwable $e) {
            db()->rollBack();
            throw $e;
        }
        out(['ok' => true, 'dupes' => $dupes]);
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
    // PATCH /vacancies/{id}/contacts {hr_contacts:[{kind,value,name?,note?,source?}], apply_note?}
    // прямые контакты нанимающей стороны: hh часто режет отклик фильтрами, поэтому пишем в обход площадки.
    // Есть хоть один контакт → статус direct; вычистили все → откат в applied (отклик-то был отправлен).
    if ($method === 'PATCH' && preg_match('#^/vacancies/(\d+)/contacts$#', $path, $m)) {
        $id = (int)$m[1];
        $b = body();
        $kinds = ['email', 'tg', 'linkedin', 'phone', 'site', 'other'];
        $contacts = [];
        foreach ((array)($b['hr_contacts'] ?? []) as $c) {
            if (!is_array($c)) continue;
            $val = trim((string)($c['value'] ?? ''));
            if ($val === '') continue;
            $kind = in_array($c['kind'] ?? '', $kinds, true) ? (string)$c['kind'] : 'other';
            $contacts[] = ['kind' => $kind, 'value' => $val,
                           'name' => trim((string)($c['name'] ?? '')), 'note' => trim((string)($c['note'] ?? '')),
                           'source' => trim((string)($c['source'] ?? ''))];
        }
        $sets = ['hr_contacts = CAST(:hc AS jsonb)'];
        $args = [':id' => $id, ':hc' => json_encode($contacts, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)];
        if (array_key_exists('apply_note', $b)) { $sets[] = 'apply_note = :an'; $args[':an'] = (string)$b['apply_note']; }
        // skipped не воскрешаем: юзер отказался от вакансии осознанно.
        // Откат ведём в applied только по hh — только там ждут поиска контактов, остальные закрыты.
        if ($contacts) {
            // слабое соответствие в работу не берём даже с контактами на руках — сразу закрываем
            $sets[] = "apply_status = CASE WHEN apply_status = 'skipped' THEN apply_status
                                           WHEN score < " . SCORE_MIN . " THEN 'done'
                                           ELSE 'direct' END";
        } else {
            $sets[] = "apply_status = CASE WHEN apply_status = 'direct' THEN :back ELSE apply_status END";
            $args[':back'] = vacOnHh($id) ? 'applied' : 'done';
        }
        db()->prepare('UPDATE vacancies SET ' . implode(', ', $sets) . ' WHERE id = :id')->execute($args);
        out(['ok' => true, 'contacts' => count($contacts)]);
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

    // --- записи встреч ---
    // GET /recordings — список (без транскрипта, но с числом реплик)
    if ($method === 'GET' && $path === '/recordings') {
        $rows = db()->query('SELECT r.*, (SELECT count(*) FROM recording_lines l WHERE l.recording_id = r.id) AS lines_n
                             FROM recordings r ORDER BY r.started_at DESC')->fetchAll();
        out(array_map(static function (array $r): array {
            $x = recRow($r);
            $x['lines'] = (int)$r['lines_n'];
            return $x;
        }, $rows));
    }
    // GET /recordings/{id} — запись + вся расшифровка
    if ($method === 'GET' && preg_match('#^/recordings/(\d+)$#', $path, $m)) {
        $st = db()->prepare('SELECT * FROM recordings WHERE id = :id');
        $st->execute([':id' => (int)$m[1]]);
        $r = $st->fetch();
        if (!$r) fail('not found', 404);
        $ls = db()->prepare('SELECT t_ms, text, speaker FROM recording_lines WHERE recording_id = :id ORDER BY t_ms, id');
        $ls->execute([':id' => (int)$m[1]]);
        out(['rec' => recRow($r), 'lines' => array_map(static function (array $l): array {
            return ['t' => (int)$l['t_ms'], 'text' => $l['text'], 'speaker' => $l['speaker']];
        }, $ls->fetchAll())]);
    }
    // POST /recordings {title?, mime?} — завести запись и пустой файл под неё
    if ($method === 'POST' && $path === '/recordings') {
        $b = body();
        $mime = trim((string)($b['mime'] ?? '')) ?: 'video/webm';
        $title = trim((string)($b['title'] ?? '')) ?: 'Встреча';
        $st = db()->prepare("INSERT INTO recordings(title, mime) VALUES (:t, :m) RETURNING id");
        $st->execute([':t' => $title, ':m' => $mime]);
        $id = (int)$st->fetchColumn();
        $file = 'rec-' . $id . '.' . (strpos($mime, 'mp4') !== false ? 'mp4' : 'webm');
        if (!is_dir(REC_DIR)) @mkdir(REC_DIR, 0777, true);
        // пустой файл создаём сразу: проблему с правами на папку лучше поймать здесь, а не на середине встречи
        if (@file_put_contents(REC_DIR . '/' . $file, '') === false) {
            db()->prepare("UPDATE recordings SET status = 'failed' WHERE id = :id")->execute([':id' => $id]);
            fail('не могу писать в папку записей — проверь права на ./recordings', 500);
        }
        db()->prepare('UPDATE recordings SET file = :f WHERE id = :id')->execute([':f' => $file, ':id' => $id]);
        out(['ok' => true, 'id' => (string)$id, 'file' => $file, 'url' => '/rec/' . $file]);
    }
    // POST /recordings/{id}/chunk?seq=N — дописать кусок в конец файла (тело — сырые байты)
    if ($method === 'POST' && preg_match('#^/recordings/(\d+)/chunk$#', $path, $m)) {
        $id = (int)$m[1];
        $st = db()->prepare('SELECT file, chunks FROM recordings WHERE id = :id');
        $st->execute([':id' => $id]);
        $r = $st->fetch();
        if (!$r) fail('not found', 404);
        if ((string)$r['file'] === '') fail('у записи нет файла', 409);
        $have = (int)$r['chunks'];
        $seq = isset($_GET['seq']) ? (int)$_GET['seq'] : -1;
        // ответ мог потеряться, и клиент шлёт кусок повторно — второй раз в файл его писать нельзя (битые кластеры)
        if ($seq >= 0 && $seq < $have) out(['ok' => true, 'dup' => true, 'chunks' => $have]);
        if ($seq > $have) fail('кусок не по порядку: жду ' . $have, 409);
        $data = file_get_contents('php://input');
        if ($data === false || $data === '') fail('пустой кусок');
        $fp = @fopen(REC_DIR . '/' . $r['file'], 'ab');
        if (!$fp) fail('не открыть файл записи', 500);
        $ok = fwrite($fp, $data);
        fclose($fp);
        if ($ok === false) fail('не записать кусок на диск', 500);
        $size = (int)@filesize(REC_DIR . '/' . $r['file']);
        db()->prepare('UPDATE recordings SET chunks = chunks + 1, size_bytes = :s WHERE id = :id')
            ->execute([':s' => $size, ':id' => $id]);
        out(['ok' => true, 'chunks' => $have + 1, 'size' => $size]);
    }
    // POST /recordings/{id}/finish {duration_ms} — запись закончена
    if ($method === 'POST' && preg_match('#^/recordings/(\d+)/finish$#', $path, $m)) {
        $id = (int)$m[1];
        $b = body();
        $st = db()->prepare('SELECT file FROM recordings WHERE id = :id');
        $st->execute([':id' => $id]);
        $file = (string)$st->fetchColumn();
        $size = ($file !== '' && is_file(REC_DIR . '/' . $file)) ? (int)filesize(REC_DIR . '/' . $file) : 0;
        // пустой файл = писать было нечего (отказ в доступе, мгновенный стоп) — не выдаём такое за готовую запись.
        // Готовая запись сразу встаёт в очередь на точную расшифровку: браузерная — черновик, whisper считает
        // локально и бесплатно, а воркер всё равно ждёт, пока запись закончится.
        $ok = $size > 0;
        db()->prepare('UPDATE recordings SET status = :st, finished_at = now(), duration_ms = :d, size_bytes = :s,
                              whisper_status = CASE WHEN :q THEN \'queued\' ELSE whisper_status END
                        WHERE id = :id')
            ->execute([':st' => $ok ? 'done' : 'failed', ':d' => max(0, (int)($b['duration_ms'] ?? 0)),
                       ':s' => $size, ':q' => $ok ? 'true' : 'false', ':id' => $id]);
        out(['ok' => true, 'size' => $size, 'status' => $ok ? 'done' : 'failed', 'whisper' => $ok ? 'queued' : '']);
    }
    // POST /recordings/{id}/lines {lines:[{t,text}]} — реплики расшифровки (шлются пачками по ходу записи)
    if ($method === 'POST' && preg_match('#^/recordings/(\d+)/lines$#', $path, $m)) {
        $id = (int)$m[1];
        $b = body();
        $lines = $b['lines'] ?? [];
        $replace = !empty($b['replace']);          // точная расшифровка приходит целиком и вытесняет черновую
        if (!is_array($lines) || (!$lines && !$replace)) out(['ok' => true, 'added' => 0]);
        $ins = db()->prepare('INSERT INTO recording_lines(recording_id, t_ms, text, speaker) VALUES (:r, :t, :x, :s)');
        $n = 0;
        db()->beginTransaction();
        try {
            if ($replace) {
                db()->prepare('DELETE FROM recording_lines WHERE recording_id = :r')->execute([':r' => $id]);
            }
            foreach ($lines as $l) {
                if (!is_array($l)) continue;
                $txt = trim((string)($l['text'] ?? ''));
                if ($txt === '') continue;
                $sp = (string)($l['speaker'] ?? '');
                if (!in_array($sp, ['me', 'them', ''], true)) $sp = '';
                $ins->execute([':r' => $id, ':t' => max(0, (int)($l['t'] ?? 0)), ':x' => $txt, ':s' => $sp]);
                $n++;
            }
            if ($replace) {
                db()->prepare("UPDATE recordings SET transcript_kind = :k WHERE id = :id")
                    ->execute([':k' => (string)($b['kind'] ?? 'whisper'), ':id' => $id]);
            }
            db()->commit();
        } catch (Throwable $e) {
            db()->rollBack();
            throw $e;
        }
        out(['ok' => true, 'added' => $n]);
    }
    // POST /recordings/{id}/transcribe — поставить запись в очередь на точную расшифровку (её берёт воркер на хосте)
    if ($method === 'POST' && preg_match('#^/recordings/(\d+)/transcribe$#', $path, $m)) {
        $st = db()->prepare("UPDATE recordings SET whisper_status = 'queued', whisper_note = ''
                             WHERE id = :id AND status = 'done' AND file <> ''");
        $st->execute([':id' => (int)$m[1]]);
        if (!$st->rowCount()) fail('запись ещё не готова', 409);
        out(['ok' => true, 'status' => 'queued']);
    }
    // PATCH /recordings/{id}/transcribe {status, note} — воркер отмечает, что делает
    if ($method === 'PATCH' && preg_match('#^/recordings/(\d+)/transcribe$#', $path, $m)) {
        $b = body();
        $allowed = ['', 'queued', 'running', 'done', 'failed'];
        $status = in_array($b['status'] ?? '', $allowed, true) ? (string)$b['status'] : null;
        if ($status === null) fail('bad status');
        db()->prepare('UPDATE recordings SET whisper_status = :s, whisper_note = :n WHERE id = :id')
            ->execute([':s' => $status, ':n' => (string)($b['note'] ?? ''), ':id' => (int)$m[1]]);
        out(['ok' => true]);
    }
    // GET /transcribe/queue — что расшифровывать (для хостового воркера: у него нет доступа к БД напрямую)
    if ($method === 'GET' && $path === '/transcribe/queue') {
        $rows = db()->query("SELECT id, title, file, duration_ms FROM recordings
                             WHERE whisper_status = 'queued' AND status = 'done' AND file <> ''
                             ORDER BY id")->fetchAll();
        out(array_map(static function (array $r): array {
            return ['id' => (string)$r['id'], 'title' => $r['title'], 'file' => $r['file'], 'durationMs' => (int)$r['duration_ms']];
        }, $rows));
    }

    // PATCH /recordings/{id} {title} — переименовать
    if ($method === 'PATCH' && preg_match('#^/recordings/(\d+)$#', $path, $m)) {
        $b = body();
        if (!array_key_exists('title', $b)) fail('title required');
        db()->prepare('UPDATE recordings SET title = :t WHERE id = :id')
            ->execute([':t' => trim((string)$b['title']), ':id' => (int)$m[1]]);
        out(['ok' => true]);
    }
    // DELETE /recordings/{id} — вместе с файлом и расшифровкой (lines уходят каскадом)
    if ($method === 'DELETE' && preg_match('#^/recordings/(\d+)$#', $path, $m)) {
        $st = db()->prepare('SELECT file FROM recordings WHERE id = :id');
        $st->execute([':id' => (int)$m[1]]);
        $file = (string)$st->fetchColumn();
        if ($file !== '' && is_file(REC_DIR . '/' . $file)) @unlink(REC_DIR . '/' . $file);
        db()->prepare('DELETE FROM recordings WHERE id = :id')->execute([':id' => (int)$m[1]]);
        out(['ok' => true]);
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
