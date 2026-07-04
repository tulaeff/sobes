<?php
declare(strict_types=1);
// Выдаёт новые сообщения из tg-выгрузок (id > last_msg_id) по включённым tg-источникам.
// Запуск: docker compose exec php php /var/www/api/scan_tg.php

$pdo = new PDO(
    'pgsql:host=' . (getenv('PGHOST') ?: 'postgres') . ';port=5432;dbname=' . (getenv('PGDATABASE') ?: 'sobes'),
    getenv('PGUSER') ?: 'sobes',
    getenv('PGPASSWORD') ?: 'sobes',
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);

$dir = '/var/www/tg_history';
$sources = $pdo->query("SELECT id, value, title, last_msg_id FROM sources WHERE kind='tg' AND enabled ORDER BY id")
    ->fetchAll(PDO::FETCH_ASSOC);

$out = [];
foreach ($sources as $s) {
    $file = "$dir/{$s['value']}";
    if (!is_file($file)) continue;
    $last = (int)$s['last_msg_id'];
    $maxId = $last;
    $msgs = [];
    foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $m = json_decode($line, true);
        if (!$m || !isset($m['id'])) continue;
        $id = (int)$m['id'];
        if ($id <= $last) continue;
        $text = trim((string)($m['text'] ?? ''));
        if ($text === '') continue;
        $msgs[] = ['msg_id' => $id, 'text' => $text];
        if ($id > $maxId) $maxId = $id;
    }
    if ($msgs) {
        $out[] = ['source_id' => (int)$s['id'], 'chat' => ($s['title'] ?: $s['value']), 'max_id' => $maxId, 'messages' => $msgs];
    }
}

echo json_encode($out, JSON_UNESCAPED_UNICODE);
