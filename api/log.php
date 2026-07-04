<?php
declare(strict_types=1);
// Пишет запись в лог агента. На stdin — JSON: {"message":"...","kind":"...","meta":{...}}
// Запуск: echo '{"message":"..."}' | docker compose exec -T php php /var/www/api/log.php

$in = json_decode(file_get_contents('php://stdin'), true) ?: [];

$pdo = new PDO(
    'pgsql:host=' . (getenv('PGHOST') ?: 'postgres') . ';port=5432;dbname=' . (getenv('PGDATABASE') ?: 'sobes'),
    getenv('PGUSER') ?: 'sobes',
    getenv('PGPASSWORD') ?: 'sobes',
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);

$pdo->prepare('INSERT INTO agent_log(kind, message, meta) VALUES (:k, :m, :meta)')
    ->execute([
        ':k'    => (string)($in['kind'] ?? ''),
        ':m'    => (string)($in['message'] ?? ''),
        ':meta' => json_encode((object)($in['meta'] ?? []), JSON_UNESCAPED_UNICODE),
    ]);

echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
