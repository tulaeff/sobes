<?php
declare(strict_types=1);
// Форс-синхрон личных заготовок из db/personal.json в БД (перезаписывает settings).
// Вопросы/закрепы не трогает. Запуск: docker compose exec php php /var/www/api/refresh_personal.php

$personal = json_decode(file_get_contents('/var/www/db/personal.json'), true) ?: [];

$pdo = new PDO(
    'pgsql:host=' . (getenv('PGHOST') ?: 'postgres') . ';port=5432;dbname=' . (getenv('PGDATABASE') ?: 'sobes'),
    getenv('PGUSER') ?: 'sobes',
    getenv('PGPASSWORD') ?: 'sobes',
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);

$st = $pdo->prepare('INSERT INTO settings(key, value) VALUES (:k, :v)
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value');
foreach ($personal as $k => $v) {
    $st->execute([':k' => $k, ':v' => json_encode($v, JSON_UNESCAPED_UNICODE)]);
}

try { $r = new Redis(); $r->connect(getenv('REDIS_HOST') ?: 'redis', 6379, 1.0); $r->del('sobes:cards'); } catch (Throwable $e) {}

echo 'personal обновлён: ' . implode(', ', array_keys($personal)) . "\n";
