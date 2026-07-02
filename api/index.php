<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

const CACHE_KEY = 'sobes:cards';

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
    foreach ($pdo->query("SELECT key, value FROM settings WHERE key IN ('self','task')") as $s) {
        $personal[$s['key']] = json_decode($s['value'], true);
    }

    return json_encode(['categories' => $cats, 'items' => $items, 'personal' => $personal],
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
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
    // GET /cards — все карточки (из кэша)
    if ($method === 'GET' && $path === '/cards') {
        $json = cacheGet();
        if ($json === null) { $json = buildPayload(); cacheSet($json); }
        echo $json;
        exit;
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
    if (($method === 'PATCH' || $method === 'POST') && preg_match('#^/personal/(self|task)$#', $path, $m)) {
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
