<?php
declare(strict_types=1);
// Дозаливка НОВЫХ карточек из public/data/parts/*.json без TRUNCATE.
// Вставляет только те (category_key, q), которых ещё нет в БД — существующие вопросы,
// правки и закрепы сохраняются. Запуск: docker compose exec php php /var/www/api/seed_append.php

$DB   = '/var/www/db';
$PART = '/var/www/public/data/parts';

$pdo = new PDO(
    'pgsql:host=' . (getenv('PGHOST') ?: 'postgres') . ';port=5432;dbname=' . (getenv('PGDATABASE') ?: 'sobes'),
    getenv('PGUSER') ?: 'sobes',
    getenv('PGPASSWORD') ?: 'sobes',
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);

$cats = json_decode(file_get_contents("$DB/categories.json"), true);

// уже существующие вопросы по категориям — чтобы не плодить дубли
$existing = [];
$rows = $pdo->query('SELECT category_key, q FROM questions')->fetchAll(PDO::FETCH_ASSOC);
foreach ($rows as $r) { $existing[$r['category_key']][mb_strtolower(trim($r['q']))] = true; }

$maxOrder = (int)$pdo->query('SELECT COALESCE(MAX(sort_order), 0) FROM questions')->fetchColumn();

$ins = $pdo->prepare(
    'INSERT INTO questions(category_key, q, a, detail, code, tags, weight, orig, sort_order)
     VALUES (:cat, :q, :a, :detail, :code, :tags, :weight, :orig, :ord)'
);

$pdo->beginTransaction();

// новые категории (существующие названия/порядок не трогаем)
$insCat = $pdo->prepare('INSERT INTO categories(key, title, sort_order) VALUES (:k, :t, :o)
                         ON CONFLICT (key) DO NOTHING');
foreach ($cats as $ci => $c) { $insCat->execute([':k' => $c['key'], ':t' => $c['title'], ':o' => $ci]); }

$added = 0; $perCat = [];
foreach ($cats as $c) {
    $file = "$PART/{$c['key']}.json";
    if (!is_file($file)) continue;
    $arr = json_decode(file_get_contents($file), true) ?: [];
    foreach ($arr as $it) {
        $q = $it['q'] ?? '';
        $key = mb_strtolower(trim($q));
        if ($key === '' || isset($existing[$c['key']][$key])) continue; // уже есть — пропускаем
        $existing[$c['key']][$key] = true;
        $tags = $it['tags'] ?? [];
        $orig = ['q' => $q, 'a' => $it['a'] ?? '', 'detail' => $it['detail'] ?? '',
                 'code' => $it['code'] ?? '', 'tags' => $tags];
        $ins->execute([
            ':cat' => $c['key'],
            ':q' => $q, ':a' => $it['a'] ?? '', ':detail' => $it['detail'] ?? '',
            ':code' => $it['code'] ?? '',
            ':tags' => json_encode($tags, JSON_UNESCAPED_UNICODE),
            ':weight' => (int)($it['weight'] ?? 50),
            ':orig' => json_encode($orig, JSON_UNESCAPED_UNICODE),
            ':ord' => ++$maxOrder,
        ]);
        $added++; $perCat[$c['key']] = ($perCat[$c['key']] ?? 0) + 1;
    }
}
$pdo->commit();

// сброс кэша
try { $r = new Redis(); $r->connect(getenv('REDIS_HOST') ?: 'redis', 6379, 1.0); $r->del('sobes:cards'); } catch (Throwable $e) {}

echo "Добавлено новых карточек: $added\n";
foreach ($perCat as $k => $n) echo "  $k: +$n\n";
