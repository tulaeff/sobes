<?php
declare(strict_types=1);
// Наполнение БД из public/data/parts/*.json + db/categories.json + db/personal.json.
// Запуск в контейнере: docker compose exec php php /var/www/api/seed.php

$DB   = '/var/www/db';
$PART = '/var/www/public/data/parts';

$pdo = new PDO(
    'pgsql:host=' . (getenv('PGHOST') ?: 'postgres') . ';port=5432;dbname=' . (getenv('PGDATABASE') ?: 'sobes'),
    getenv('PGUSER') ?: 'sobes',
    getenv('PGPASSWORD') ?: 'sobes',
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);

// схема
$pdo->exec(file_get_contents("$DB/schema.sql"));

$cats = json_decode(file_get_contents("$DB/categories.json"), true);
$personal = json_decode(file_get_contents("$DB/personal.json"), true);

$pdo->beginTransaction();
// перезаливаем только вопросы; категории и personal редактируются в БД и НЕ затираются
$pdo->exec('TRUNCATE questions RESTART IDENTITY');

$insCat = $pdo->prepare('INSERT INTO categories(key, title, sort_order) VALUES (:k, :t, :o)
                         ON CONFLICT (key) DO NOTHING');
$insQ = $pdo->prepare(
    'INSERT INTO questions(category_key, q, a, detail, code, tags, weight, orig, sort_order)
     VALUES (:cat, :q, :a, :detail, :code, :tags, :weight, :orig, :ord)'
);

$order = 0; $nq = 0;
foreach ($cats as $ci => $c) {
    $insCat->execute([':k' => $c['key'], ':t' => $c['title'], ':o' => $ci]);
    $file = "$PART/{$c['key']}.json";
    if (!is_file($file)) { fwrite(STDERR, "нет файла $file\n"); continue; }
    $arr = json_decode(file_get_contents($file), true) ?: [];
    foreach ($arr as $it) {
        $tags = $it['tags'] ?? [];
        $orig = ['q' => $it['q'] ?? '', 'a' => $it['a'] ?? '', 'detail' => $it['detail'] ?? '',
                 'code' => $it['code'] ?? '', 'tags' => $tags];
        $insQ->execute([
            ':cat' => $c['key'],
            ':q' => $it['q'] ?? '', ':a' => $it['a'] ?? '', ':detail' => $it['detail'] ?? '',
            ':code' => $it['code'] ?? '',
            ':tags' => json_encode($tags, JSON_UNESCAPED_UNICODE),
            ':weight' => (int)($it['weight'] ?? 50),
            ':orig' => json_encode($orig, JSON_UNESCAPED_UNICODE),
            ':ord' => $order++,
        ]);
        $nq++;
    }
}

$insS = $pdo->prepare('INSERT INTO settings(key, value) VALUES (:k, :v) ON CONFLICT (key) DO NOTHING');
foreach (['self', 'task', 'jobs', 'ask'] as $k) {
    $insS->execute([':k' => $k, ':v' => json_encode($personal[$k] ?? new stdClass(), JSON_UNESCAPED_UNICODE)]);
}

$pdo->commit();

// сбросим кэш, если Redis есть
try { $r = new Redis(); $r->connect(getenv('REDIS_HOST') ?: 'redis', 6379, 1.0); $r->del('sobes:cards'); } catch (Throwable $e) {}

echo "OK: категорий " . count($cats) . ", вопросов $nq\n";
