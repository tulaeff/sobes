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

// тг-источники всегда требуют ручного отклика (контакт в посте, автоформы нет) — сразу в "Ручной разбор"
$tgSourceIds = array_map('intval', array_column(
    $pdo->query("SELECT id FROM sources WHERE kind = 'tg'")->fetchAll(PDO::FETCH_ASSOC),
    'id'
));

$ins = $pdo->prepare(
    'INSERT INTO vacancies(source_id, chat, msg_id, score, title, reason, link, text, link_text, mismatches, company, apply_status, apply_note)
     VALUES (:sid, :chat, :mid, :score, :title, :reason, :link, :text, :ltext, :miss, :company, :st, :note)
     ON CONFLICT (source_id, msg_id) DO NOTHING'
);
// соответствие ниже порога — в работу не берём: ни отклика, ни поиска контактов, сразу «Завершено»
const SCORE_MIN = 70;

$saved = 0;
foreach (($in['matches'] ?? []) as $v) {
    $sid = (int)$v['source_id'];
    $isTg = in_array($sid, $tgSourceIds, true);
    $weak = (int)($v['score'] ?? 0) < SCORE_MIN;
    $ins->execute([
        ':sid' => $sid, ':chat' => (string)($v['chat'] ?? ''), ':mid' => (int)$v['msg_id'],
        ':score' => (int)($v['score'] ?? 0), ':title' => trim((string)($v['title'] ?? '')), // краевые \n от модели ломают сравнение групп
        ':reason' => (string)($v['reason'] ?? ''), ':link' => (string)($v['link'] ?? ''),
        ':text' => (string)($v['text'] ?? ''),
        ':ltext' => (string)($v['link_text'] ?? ''),
        ':miss' => json_encode(array_values((array)($v['mismatches'] ?? [])), JSON_UNESCAPED_UNICODE),
        ':company' => trim((string)($v['company'] ?? '')), // работодатель — по нему дедуп отличает разные вакансии с одним названием
        ':st' => $weak ? 'done' : ($isTg ? 'needs_manual' : 'new'),
        ':note' => $weak ? 'соответствие ниже ' . SCORE_MIN . '% — в работу не берём'
                         : ($isTg ? 'Тг-вакансия — контакт в посте, отклик только вручную' : ''),
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
