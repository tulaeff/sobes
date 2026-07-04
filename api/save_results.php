<?php
declare(strict_types=1);
// Пишет найденные вакансии и двигает last_msg_id. На stdin — JSON:
// {"matches":[{source_id,chat,msg_id,score,title,reason,link,text}], "last":{"<source_id>":maxId}}
// Запуск: cat res.json | docker compose exec -T php php /var/www/api/save_results.php

$in = json_decode(file_get_contents('php://stdin'), true) ?: [];

$pdo = new PDO(
    'pgsql:host=' . (getenv('PGHOST') ?: 'postgres') . ';port=5432;dbname=' . (getenv('PGDATABASE') ?: 'sobes'),
    getenv('PGUSER') ?: 'sobes',
    getenv('PGPASSWORD') ?: 'sobes',
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);

$pdo->beginTransaction();

$ins = $pdo->prepare(
    'INSERT INTO vacancies(source_id, chat, msg_id, score, title, reason, link, text, link_text, mismatches)
     VALUES (:sid, :chat, :mid, :score, :title, :reason, :link, :text, :ltext, :miss)
     ON CONFLICT (source_id, msg_id) DO NOTHING'
);
$saved = 0;
foreach (($in['matches'] ?? []) as $v) {
    $ins->execute([
        ':sid' => (int)$v['source_id'], ':chat' => (string)($v['chat'] ?? ''), ':mid' => (int)$v['msg_id'],
        ':score' => (int)($v['score'] ?? 0), ':title' => (string)($v['title'] ?? ''),
        ':reason' => (string)($v['reason'] ?? ''), ':link' => (string)($v['link'] ?? ''),
        ':text' => (string)($v['text'] ?? ''),
        ':ltext' => (string)($v['link_text'] ?? ''),
        ':miss' => json_encode(array_values((array)($v['mismatches'] ?? [])), JSON_UNESCAPED_UNICODE),
    ]);
    $saved += $ins->rowCount();
}

// сдвигаем last_msg_id (только вперёд)
$upd = $pdo->prepare('UPDATE sources SET last_msg_id = GREATEST(last_msg_id, :m) WHERE id = :id');
foreach (($in['last'] ?? []) as $sid => $mid) { $upd->execute([':m' => (int)$mid, ':id' => (int)$sid]); }

// отметка о прогоне + снимаем запрос ручного прогона
$pdo->prepare("INSERT INTO settings(key, value) VALUES('analyze_last', :v)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value")
    ->execute([':v' => json_encode(['at' => date('c'), 'matches' => count($in['matches'] ?? [])], JSON_UNESCAPED_UNICODE)]);
$pdo->prepare("DELETE FROM settings WHERE key = 'analyze_requested'")->execute();

$pdo->commit();
echo json_encode(['ok' => true, 'saved' => $saved], JSON_UNESCAPED_UNICODE);
